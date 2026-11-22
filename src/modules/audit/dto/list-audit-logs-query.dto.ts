import { audit_action, audit_entity } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export const ALL_AUDIT_ACTIONS = new Set<string>([
  'APPLICATION_SUBMITTED',
  'APPLICATION_REVIEW_STARTED',
  'APPLICATION_APPROVED',
  'APPLICATION_REJECTED',
  'APPLICATION_CANCELLED',
  'CREDENTIAL_ISSUED',
  'CREDENTIAL_REVOKED',
  'DELIVERY_CREATED',
  'DELIVERY_ASSIGNED',
  'DELIVERY_OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'DELIVERY_COMPLETED',
  'SERVICE_CREATED',
  'SERVICE_UPDATED',
  'SERVICE_PUBLISHED',
  'SERVICE_UNPUBLISHED',
  'SERVICE_DELETED',
  'STAFF_CREATED',
  'STAFF_UPDATED',
  'CITIZEN_DEACTIVATED',
  'CITIZEN_REACTIVATED',
  'PAYMENT_MARKED_PAID_MOCK',
  'PASSWORD_RESET_COMPLETED',
  'SETTINGS_UPDATED',
] satisfies audit_action[]);

export const ALL_AUDIT_ENTITIES = [
  'APPLICATION',
  'SERVICE',
  'CREDENTIAL',
  'DELIVERY',
  'USER',
  'SETTINGS',
] as const satisfies readonly audit_entity[];

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  action?: string;

  @IsOptional()
  @Trim()
  @IsIn(ALL_AUDIT_ENTITIES)
  entityType?: audit_entity;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  entityId?: string;

  @IsOptional()
  @Trim()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @Trim()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @Trim()
  @IsISO8601()
  to?: string;
}
