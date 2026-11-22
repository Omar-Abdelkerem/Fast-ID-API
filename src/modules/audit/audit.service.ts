import { Injectable } from '@nestjs/common';
import { audit_action, audit_entity, Prisma } from '@prisma/client';
import { createPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { AppException } from '../../common/errors/app-exception';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { PrismaTx } from '../../database/transaction';
import { AuditLogResponse, mapAuditLogResponse } from './audit-log-response.mapper';
import { ALL_AUDIT_ACTIONS, ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface RecordAuditParams {
  actorId: string | null;
  action: audit_action;
  entityType: audit_entity;
  entityId: string;
  metadata?: Prisma.InputJsonObject;
}

function parseAuditActions(raw?: string): audit_action[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (values.length === 0) {
    return undefined;
  }

  for (const val of values) {
    if (!ALL_AUDIT_ACTIONS.has(val)) {
      throw new AppException('VALIDATION_ERROR', `Invalid audit action "${val}".`, {
        field: 'action',
        details: [
          {
            field: 'action',
            code: 'INVALID_VALUE',
            message: `Invalid audit action "${val}".`,
          },
        ],
      });
    }
  }

  return values as audit_action[];
}

function isValidEntityId(value: string): boolean {
  if (value === 'singleton') {
    return true;
  }
  if (isUuid(value)) {
    return true;
  }
  return value.length >= 3 && value.length <= 60 && SLUG_PATTERN.test(value);
}

/**
 * Append-only audit log writer and admin query service (Design §4.1, §6.2, Contract §10.6, §11).
 * Never store personal data in metadata.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

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

  async list(query: ListAuditLogsQueryDto): Promise<PaginatedResult<AuditLogResponse>> {
    const actions = parseAuditActions(query.action);

    if (query.entityId !== undefined && !isValidEntityId(query.entityId)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'entityId must be a valid UUID, service slug, or "singleton".',
        {
          field: 'entityId',
          details: [
            {
              field: 'entityId',
              code: 'INVALID_FORMAT',
              message: 'entityId must be a valid UUID, service slug, or "singleton".',
            },
          ],
        },
      );
    }

    const fromDate = query.from ? new Date(query.from) : undefined;
    const toDate = query.to ? new Date(query.to) : undefined;
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new AppException('VALIDATION_ERROR', 'from must be less than or equal to to.', {
        field: 'from',
        details: [
          {
            field: 'from',
            code: 'OUT_OF_RANGE',
            message: 'from must be less than or equal to to.',
          },
        ],
      });
    }

    const andClauses: Prisma.audit_logsWhereInput[] = [];
    if (actions) {
      andClauses.push({ action: { in: actions } });
    }
    if (query.entityType) {
      andClauses.push({ entity_type: query.entityType });
    }
    if (query.entityId) {
      andClauses.push({ entity_id: query.entityId });
    }
    if (query.actorId) {
      andClauses.push({ actor_id: query.actorId });
    }
    if (fromDate || toDate) {
      andClauses.push({
        created_at: {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lte: toDate } : {}),
        },
      });
    }

    const where: Prisma.audit_logsWhereInput = andClauses.length > 0 ? { AND: andClauses } : {};
    const skip = (query.page - 1) * query.pageSize;

    const [total, rows] = await Promise.all([
      this.prisma.audit_logs.count({ where }),
      this.prisma.audit_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
        include: {
          users: {
            select: { id: true, full_name: true, role: true },
          },
        },
      }),
    ]);

    return createPaginatedResult(rows.map(mapAuditLogResponse), total, query.page, query.pageSize);
  }
}
