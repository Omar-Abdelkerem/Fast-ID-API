import { governorate } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { ADMIN_APPLICATION_SORTS, AdminApplicationSort } from './list-admin-applications-query.dto';

/**
 * Same filter & sort query parameters as §7.1, excluding `page` and `pageSize` (Contract §7.2).
 */
export class ExportAdminApplicationsQueryDto {
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
