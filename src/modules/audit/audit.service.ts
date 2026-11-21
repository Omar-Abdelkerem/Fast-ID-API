import { Injectable } from '@nestjs/common';
import { audit_action, audit_entity, Prisma } from '@prisma/client';
import { PrismaTx } from '../../database/transaction';

export interface RecordAuditParams {
  actorId: string | null;
  action: audit_action;
  entityType: audit_entity;
  entityId: string;
  metadata?: Prisma.InputJsonObject;
}

/**
 * Append-only audit log writer (Design §4.1, §6.2, Contract §11).
 * Always called inside the same database transaction as the mutation it records.
 * Never store personal data in metadata.
 */
@Injectable()
export class AuditService {
  async recordInTx(tx: PrismaTx, params: RecordAuditParams): Promise<void> {
    await tx.audit_logs.create({
      data: {
        actor_id: params.actorId,
        action: params.action,
        entity_type: params.entityType,
        entity_id: params.entityId,
        metadata: params.metadata ?? {},
      },
    });
  }
}
