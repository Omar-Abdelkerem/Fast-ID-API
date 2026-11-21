import { IsNotEmpty, IsString } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator';

export class UploadAttachmentDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  requirementKey: string;
}
