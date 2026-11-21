import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class DeliverDeliveryDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9]{6}$/, { message: 'code must be exactly 6 digits.' })
  code: string;
}
