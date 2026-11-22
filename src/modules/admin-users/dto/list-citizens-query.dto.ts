import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export const CITIZEN_SORTS = ['createdAt', '-createdAt'] as const;
export type CitizenSort = (typeof CITIZEN_SORTS)[number];

export class ListCitizensQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 100)
  q?: string;

  @IsOptional()
  @Trim()
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';

  @IsOptional()
  @Trim()
  @IsIn(CITIZEN_SORTS)
  sort: CitizenSort = '-createdAt';
}
