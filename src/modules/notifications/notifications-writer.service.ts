import { Injectable } from '@nestjs/common';
import { notification_entity, notification_type, notifications } from '@prisma/client';
import { PrismaTx } from '../../database/transaction';
import { buildNotificationContent, NotificationTemplateParams } from './notification-templates';
import { SessionStreamRegistry } from './session-stream-registry';

export interface CreateNotificationParams {
  userId: string;
  type: notification_type;
  entityType: notification_entity;
  entityId: string;
  templateParams?: NotificationTemplateParams;
}

/**
 * Leaf notification writer (Design §4.1, §9).
 * Always inserts inside the caller's transaction; publishes to SSE after commit only.
 */
@Injectable()
export class NotificationsWriterService {
  constructor(private readonly streamRegistry: SessionStreamRegistry) {}

  async createInTx(tx: PrismaTx, params: CreateNotificationParams): Promise<notifications> {
    const content = buildNotificationContent(params.type, params.templateParams);

    return tx.notifications.create({
      data: {
        user_id: params.userId,
        type: params.type,
        title: content.title,
        body: content.body,
        entity_type: params.entityType,
        entity_id: params.entityId,
      },
    });
  }

  publishAfterCommit(items: notifications[]): void {
    if (items.length === 0) {
      return;
    }
    this.streamRegistry.publishNotifications(items);
  }
}
