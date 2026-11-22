import { IsBoolean } from 'class-validator';

export class UpdateCitizenDto {
  @IsBoolean()
  isActive!: boolean;
}
