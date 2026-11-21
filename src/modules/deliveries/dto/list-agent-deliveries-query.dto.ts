import { IsIn, IsOptional, IsString } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class ListAgentDeliveriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  status?: string;

  @IsOptional()
  @Trim()
  @IsIn(['assignedAt', '-assignedAt'])
  sort: 'assignedAt' | '-assignedAt' = 'assignedAt';
}
