import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export const STAFF_ROLES = ['ADMIN', 'AGENT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export class CreateStaffDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @Trim()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @Trim()
  @IsIn(STAFF_ROLES)
  role!: StaffRole;

  @IsOptional()
  @Trim()
  @IsString()
  governorate?: string;

  @IsString()
  @IsNotEmpty()
  temporaryPassword!: string;
}
