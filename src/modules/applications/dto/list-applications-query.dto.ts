import { application_status } from '@prisma/client';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export const CITIZEN_APPLICATION_SORTS = [
  'createdAt',
  '-createdAt',
  'updatedAt',
  '-updatedAt',
] as const;
export type CitizenApplicationSort = (typeof CITIZEN_APPLICATION_SORTS)[number];

export const ALL_APPLICATION_STATUSES = new Set<string>([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] satisfies application_status[]);

export class ListApplicationsQueryDto extends PaginationQueryDto {
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
  @IsIn(CITIZEN_APPLICATION_SORTS)
  sort: CitizenApplicationSort = '-createdAt';
}
