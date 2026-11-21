import { delivery_status, governorate } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export const ALL_DELIVERY_STATUSES = new Set<string>([
  'PENDING_ASSIGNMENT',
  'ASSIGNED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_ATTEMPT',
] satisfies delivery_status[]);

export class ListAdminDeliveriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  status?: string;

  @IsOptional()
  @Trim()
  @IsString()
  governorate?: governorate;

  @IsOptional()
  @Trim()
  @IsUUID('4')
  agentId?: string;

  @IsOptional()
  @Trim()
  @IsIn(['true', 'false'])
  unassigned?: 'true' | 'false';

  @IsOptional()
  @Trim()
  @IsIn(['createdAt', '-createdAt'])
  sort: 'createdAt' | '-createdAt' = '-createdAt';
}
