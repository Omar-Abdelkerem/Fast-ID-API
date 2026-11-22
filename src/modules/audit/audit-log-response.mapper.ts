import { audit_action, audit_entity, audit_logs, user_role } from '@prisma/client';

export interface AuditLogResponse {
  id: string;
  actor: {
    id: string;
    fullName: string;
    role: user_role;
  } | null;
  action: audit_action;
  entityType: audit_entity;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type AuditLogWithActorRow = audit_logs & {
  users: {
    id: string;
    full_name: string;
    role: user_role;
  } | null;
};

export function mapAuditLogResponse(row: AuditLogWithActorRow): AuditLogResponse {
  return {
    id: row.id,
    actor: row.users
      ? {
          id: row.users.id,
          fullName: row.users.full_name,
          role: row.users.role,
        }
      : null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at.toISOString(),
  };
}
