import { IsNotEmpty, IsUUID } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class AssignDeliveryDto {
  @Trim()
  @IsNotEmpty()
  @IsUUID('4')
  agentId: string;
}
