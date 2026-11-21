import { application_status, governorate } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export const ADMIN_APPLICATION_STATUSES = new Set<string>([
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] satisfies Exclude<application_status, 'DRAFT'>[]);

export const ADMIN_APPLICATION_SORTS = ['submittedAt', '-submittedAt', 'dueAt', '-dueAt'] as const;
export type AdminApplicationSort = (typeof ADMIN_APPLICATION_SORTS)[number];

export class ListAdminApplicationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  status?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  serviceId?: string;

  @IsOptional()
  @Trim()
  @IsString()
  governorate?: governorate;

  @IsOptional()
  @Trim()
  @IsIn(['true', 'false'])
  overdue?: 'true' | 'false';

  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 100)
  q?: string;

  @IsOptional()
  @Trim()
  @IsISO8601()
  submittedFrom?: string;

  @IsOptional()
  @Trim()
  @IsISO8601()
  submittedTo?: string;

  @IsOptional()
  @Trim()
  @IsIn(ADMIN_APPLICATION_SORTS)
  sort: AdminApplicationSort = '-submittedAt';
}
