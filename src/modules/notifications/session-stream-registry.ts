import { Injectable, OnModuleDestroy } from '@nestjs/common';

export interface SseDisconnectHandler {
  disconnectUser(userId: string): void;
  closeAll(): void;
}

/**
 * Leaf registry allowing auth/users modules to disconnect a user's active SSE streams
 * on logout, password change/reset, and account deactivation (Design D-08, §5.3, §9).
 * M5's NotificationsBroadcaster registers itself here on boot.
 */
@Injectable()
export class SessionStreamRegistry implements OnModuleDestroy {
  private handler: SseDisconnectHandler | null = null;

  registerHandler(handler: SseDisconnectHandler): void {
    this.handler = handler;
  }

  disconnectUser(userId: string): void {
    this.handler?.disconnectUser(userId);
  }

  onModuleDestroy(): void {
    this.handler?.closeAll();
  }
}
