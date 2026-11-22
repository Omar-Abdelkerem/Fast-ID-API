import { notification_entity, notification_type, notifications } from '@prisma/client';
import { LocalizedText } from '../services/service-definition.types';

export interface NotificationResponse {
  id: string;
  type: notification_type;
  title: LocalizedText;
  body: LocalizedText;
  entity: {
    type: notification_entity;
    id: string;
  };
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export function mapNotificationResponse(row: notifications): NotificationResponse {
  return {
    id: row.id,
    type: row.type,
    title: row.title as unknown as LocalizedText,
    body: row.body as unknown as LocalizedText,
    entity: {
      type: row.entity_type,
      id: row.entity_id,
    },
    isRead: row.is_read,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
