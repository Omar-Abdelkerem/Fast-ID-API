import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class CreateApplicationDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @Length(3, 60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'serviceId must be a valid service slug.',
  })
  serviceId: string;
}
