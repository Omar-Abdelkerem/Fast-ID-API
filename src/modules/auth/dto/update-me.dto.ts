import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class UpdateMeDto {
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsIn(['ar', 'en'])
  preferredLanguage?: 'ar' | 'en';
}
