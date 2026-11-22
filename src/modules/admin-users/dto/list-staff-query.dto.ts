import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { STAFF_ROLES, StaffRole } from './create-staff.dto';

export const STAFF_SORTS = ['createdAt', '-createdAt', 'fullName', '-fullName'] as const;
export type StaffSort = (typeof STAFF_SORTS)[number];

export class ListStaffQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsIn(STAFF_ROLES)
  role?: StaffRole;

  @IsOptional()
  @Trim()
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';

  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 100)
  q?: string;

  @IsOptional()
  @Trim()
  @IsIn(STAFF_SORTS)
  sort: StaffSort = '-createdAt';
}
