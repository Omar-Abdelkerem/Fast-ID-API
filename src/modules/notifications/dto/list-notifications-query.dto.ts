import { IsIn, IsOptional } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsIn(['true', 'false'])
  isRead?: 'true' | 'false';
}
