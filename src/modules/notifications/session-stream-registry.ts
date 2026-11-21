import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { notifications } from '@prisma/client';

export interface SseStreamHandler {
  disconnectUser(userId: string): void;
  publishNotifications(items: notifications[]): void;
  closeAll(): void;
}

/**
 * Leaf registry allowing auth/users/applications/deliveries to publish live notifications
 * and disconnect active SSE streams without circular module dependencies (Design D-08, §4.1).
 */
@Injectable()
export class SessionStreamRegistry implements OnModuleDestroy {
  private handler: SseStreamHandler | null = null;

  registerHandler(handler: SseStreamHandler): void {
    this.handler = handler;
  }

  disconnectUser(userId: string): void {
    this.handler?.disconnectUser(userId);
  }

  publishNotifications(items: notifications[]): void {
    this.handler?.publishNotifications(items);
  }

  onModuleDestroy(): void {
    this.handler?.closeAll();
  }
}
