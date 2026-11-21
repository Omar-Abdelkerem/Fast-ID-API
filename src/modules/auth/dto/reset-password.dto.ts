import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class ResetPasswordDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}
