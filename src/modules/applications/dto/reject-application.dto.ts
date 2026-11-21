import { reject_reason_code } from '@prisma/client';
import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export const REJECT_REASON_CODES: readonly reject_reason_code[] = [
  'INCOMPLETE_DOCUMENTS',
  'UNCLEAR_DOCUMENTS',
  'INVALID_DATA',
  'DUPLICATE_REQUEST',
  'OTHER',
] as const;

export class RejectApplicationDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @IsIn(REJECT_REASON_CODES)
  reasonCode: reject_reason_code;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
