import { delivery_failure_code } from '@prisma/client';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export const DELIVERY_FAILURE_CODES: readonly delivery_failure_code[] = [
  'CITIZEN_UNAVAILABLE',
  'WRONG_ADDRESS',
  'CITIZEN_REFUSED',
  'OTHER',
] as const;

export class FailDeliveryDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @IsIn(DELIVERY_FAILURE_CODES)
  reasonCode: delivery_failure_code;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
