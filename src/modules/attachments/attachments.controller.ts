import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { UserRateLimit } from '../../common/guards/user-rate-limit.guard';
import { AttachmentResponse } from '../applications/application-response.mapper';
import { AttachmentsService } from './attachments.service';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';

const HARD_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB (Contract §0.20, Design §8)

@Controller('applications/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Roles('CITIZEN')
  @UserRateLimit({ name: 'attachments-upload', limit: 30, windowMs: 10 * 60_000 })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: HARD_UPLOAD_LIMIT_BYTES, files: 1 },
    }),
  )
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') applicationId: string,
    @Body() dto: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<AttachmentResponse> {
    return this.attachmentsService.upload(citizen, applicationId, dto.requirementKey, file);
  }

  @Roles('CITIZEN', 'ADMIN')
  @SkipEnvelope()
  @Get(':attachmentId/file')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') applicationId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.attachmentsService.streamFile(user, applicationId, attachmentId, res);
  }

  @Roles('CITIZEN')
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') applicationId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<{ id: string; deleted: true }> {
    return this.attachmentsService.deleteAttachment(citizen, applicationId, attachmentId);
  }
}
