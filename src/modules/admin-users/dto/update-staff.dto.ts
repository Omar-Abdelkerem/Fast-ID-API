import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class UpdateStaffDto {
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  fullName?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  governorate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
