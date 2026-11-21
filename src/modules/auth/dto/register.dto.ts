import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class RegisterDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  nationalId: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsIn(['ar', 'en'])
  preferredLanguage?: 'ar' | 'en';

  @IsDefined()
  @IsBoolean()
  acceptTerms: boolean;
}
