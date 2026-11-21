import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class CancelApplicationDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
