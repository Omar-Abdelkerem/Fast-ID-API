import { EventEmitter } from 'events';
import { notifications } from '@prisma/client';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppException } from '../../common/errors/app-exception';
import { NotificationsBroadcasterService } from './notifications-broadcaster.service';
import { SessionStreamRegistry } from './session-stream-registry';

function createMockStreamPair() {
  const req = new EventEmitter() as unknown as Request;
  const resEmitter = new EventEmitter();
  const writes: string[] = [];
  let ended = false;
  const headers: Record<string, string> = {};

  const res = Object.assign(resEmitter, {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    vary: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      ended = true;
      resEmitter.emit('close');
    }),
    get writableEnded() {
      return ended;
    },
  }) as unknown as Response;

  return { req, res, writes, headers };
}

function makeUser(id: string, expOffsetSec = 3600): AuthenticatedUser {
  return {
    id,
    jwtExp: Math.floor(Date.now() / 1000) + expOffsetSec,
  } as AuthenticatedUser;
}

describe('NotificationsBroadcasterService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enforces 3-stream limit per user before flushing SSE headers and delivers live events', () => {
    const registry = new SessionStreamRegistry();
    const broadcaster = new NotificationsBroadcasterService(registry);
    broadcaster.onModuleInit();

    const user = makeUser('user-1');
    const s1 = createMockStreamPair();
    const s2 = createMockStreamPair();
    const s3 = createMockStreamPair();
    const s4 = createMockStreamPair();

    broadcaster.attachStream(user, s1.req, s1.res);
    broadcaster.attachStream(user, s2.req, s2.res);
    broadcaster.attachStream(user, s3.req, s3.res);
    expect(broadcaster.activeStreamCount('user-1')).toBe(3);

    expect(() => broadcaster.attachStream(user, s4.req, s4.res)).toThrow(AppException);
    expect(s4.res.flushHeaders).not.toHaveBeenCalled();
    expect(s4.headers['retry-after']).toBe('30');

    // Publish event reaches all 3 streams
    const notif: notifications = {
      id: 'n-1',
      user_id: 'user-1',
      type: 'APPLICATION_SUBMITTED',
      title: { ar: 'أ', en: 'A' },
      body: { ar: 'ب', en: 'B' },
      entity_type: 'APPLICATION',
      entity_id: 'app-1',
      is_read: false,
      read_at: null,
      created_at: new Date('2026-11-22T00:00:00.000Z'),
    };
    broadcaster.publishNotifications([notif]);
    expect(s1.writes.some((w) => w.startsWith('event: notification\ndata: '))).toBe(true);

    // 25s ping timer emits keep-alive
    jest.advanceTimersByTime(25_000);
    expect(s1.writes).toContain('event: ping\ndata: {}\n\n');

    // disconnectUser closes all streams for user-1
    broadcaster.disconnectUser('user-1');
    expect(broadcaster.activeStreamCount('user-1')).toBe(0);
    expect(s1.res.end).toHaveBeenCalled();
    expect(s2.res.end).toHaveBeenCalled();
    expect(s3.res.end).toHaveBeenCalled();
  });

  it('auto-closes SSE stream when JWT exp is reached', () => {
    const registry = new SessionStreamRegistry();
    const broadcaster = new NotificationsBroadcasterService(registry);
    const user = makeUser('user-exp', 5);
    const stream = createMockStreamPair();

    broadcaster.attachStream(user, stream.req, stream.res);
    expect(broadcaster.activeStreamCount('user-exp')).toBe(1);

    jest.advanceTimersByTime(5_500);
    expect(stream.res.end).toHaveBeenCalled();
    expect(broadcaster.activeStreamCount('user-exp')).toBe(0);
  });
});
