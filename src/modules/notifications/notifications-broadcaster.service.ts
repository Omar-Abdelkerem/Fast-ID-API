import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { notifications } from '@prisma/client';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppException } from '../../common/errors/app-exception';
import { mapNotificationResponse } from './notification-response.mapper';
import { SessionStreamRegistry, SseStreamHandler } from './session-stream-registry';

const MAX_STREAMS_PER_USER = 3;
const PING_INTERVAL_MS = 25_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface ActiveStream {
  res: Response;
  pingTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout | null;
  cleanup: () => void;
}

/**
 * In-memory SSE broadcaster (Design D-08, §9, Contract §6.6):
 * - Enforces 3-stream-per-user limit BEFORE writing SSE headers (429 RATE_LIMITED JSON envelope)
 * - Sends `event: ping` every 25s
 * - Auto-closes streams on JWT `exp`, logout, password change/reset, deactivation, and shutdown
 */
@Injectable()
export class NotificationsBroadcasterService
  implements SseStreamHandler, OnModuleInit, OnModuleDestroy
{
  private readonly streamsByUser = new Map<string, Set<ActiveStream>>();

  constructor(private readonly sessionStreamRegistry: SessionStreamRegistry) {}

  onModuleInit(): void {
    this.sessionStreamRegistry.registerHandler(this);
  }

  onModuleDestroy(): void {
    this.closeAll();
  }

  activeStreamCount(userId: string): number {
    return this.streamsByUser.get(userId)?.size ?? 0;
  }

  attachStream(user: AuthenticatedUser, req: Request, res: Response): void {
    const existing = this.streamsByUser.get(user.id);
    if (existing && existing.size >= MAX_STREAMS_PER_USER) {
      res.setHeader('Retry-After', '30');
      throw new AppException('RATE_LIMITED', 'Maximum concurrent notification streams reached.');
    }

    const msUntilExpiry = user.jwtExp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      throw new AppException('UNAUTHENTICATED', 'Session has expired.');
    }

    // Write SSE headers only AFTER auth, mustChangePassword, and stream-cap checks pass.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.vary('Origin');
    res.flushHeaders();

    // Emit an SSE comment immediately so HTTP clients observe headers without waiting for first event.
    res.write(': connected\n\n');

    let cleaned = false;
    const entry: ActiveStream = {
      res,
      pingTimer: setInterval(() => {
        if (!res.writableEnded) {
          res.write('event: ping\ndata: {}\n\n');
        }
      }, PING_INTERVAL_MS),
      expiryTimer: null,
      cleanup: () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        clearInterval(entry.pingTimer);
        if (entry.expiryTimer) {
          clearTimeout(entry.expiryTimer);
          entry.expiryTimer = null;
        }
        const userSet = this.streamsByUser.get(user.id);
        if (userSet) {
          userSet.delete(entry);
          if (userSet.size === 0) {
            this.streamsByUser.delete(user.id);
          }
        }
      },
    };
    entry.pingTimer.unref();

    const delay = Math.min(msUntilExpiry, MAX_TIMEOUT_MS);
    entry.expiryTimer = setTimeout(() => {
      entry.cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }, delay);
    entry.expiryTimer.unref();

    let userSet = this.streamsByUser.get(user.id);
    if (!userSet) {
      userSet = new Set<ActiveStream>();
      this.streamsByUser.set(user.id, userSet);
    }
    userSet.add(entry);

    req.on('close', entry.cleanup);
    res.on('close', entry.cleanup);
  }

  publishNotifications(items: notifications[]): void {
    for (const item of items) {
      const userSet = this.streamsByUser.get(item.user_id);
      if (!userSet || userSet.size === 0) {
        continue;
      }

      const payload = JSON.stringify(mapNotificationResponse(item));
      const frame = `event: notification\ndata: ${payload}\n\n`;

      for (const stream of Array.from(userSet)) {
        if (stream.res.writableEnded) {
          stream.cleanup();
          continue;
        }
        stream.res.write(frame);
      }
    }
  }

  disconnectUser(userId: string): void {
    const userSet = this.streamsByUser.get(userId);
    if (!userSet) {
      return;
    }

    for (const stream of Array.from(userSet)) {
      stream.cleanup();
      if (!stream.res.writableEnded) {
        stream.res.end();
      }
    }
  }

  closeAll(): void {
    for (const userId of Array.from(this.streamsByUser.keys())) {
      this.disconnectUser(userId);
    }
  }
}
