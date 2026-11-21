import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AppException } from '../../common/errors/app-exception';
import {
  buildInlineContentDisposition,
  sanitizeOriginalName,
} from '../../common/utils/content-disposition';
import { extensionForMimeType, sniffAllowedMimeType } from '../../common/utils/magic-bytes';
import { isUuid } from '../../common/utils/uuid';
import { PrismaService } from '../../database/prisma.service';
import { lockApplication, withTx } from '../../database/transaction';
import {
  AttachmentResponse,
  mapAttachmentResponse,
} from '../applications/application-response.mapper';
import { ServiceDefinition } from '../services/service-definition.types';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage-driver.interface';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storageDriver: StorageDriver,
  ) {}

  async upload(
    citizen: AuthenticatedUser,
    applicationId: string,
    requirementKey: string,
    file: Express.Multer.File | undefined,
  ): Promise<AttachmentResponse> {
    if (!isUuid(applicationId)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    if (!file || !file.buffer || file.size === 0) {
      throw new AppException('FILE_REQUIRED', 'A non-empty file part is required.');
    }

    // 1. Pre-check ownership, DRAFT, published service, requirementKey, size, and magic bytes before writing bytes.
    const precheckApp = await this.prisma.applications.findFirst({
      where: { id: applicationId, citizen_id: citizen.id },
      include: { services: true },
    });
    if (!precheckApp) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }
    if (precheckApp.status !== 'DRAFT') {
      throw new AppException(
        'APPLICATION_NOT_EDITABLE',
        'Attachments can only be uploaded to DRAFT applications.',
      );
    }
    if (
      precheckApp.services.availability !== 'PUBLISHED' ||
      precheckApp.services.published_version === null
    ) {
      throw new AppException('SERVICE_NOT_AVAILABLE', 'Service is no longer published.');
    }

    const preVersion = await this.prisma.service_versions.findUniqueOrThrow({
      where: {
        service_id_version: {
          service_id: precheckApp.service_id,
          version: precheckApp.services.published_version,
        },
      },
    });
    const preDefinition = preVersion.definition as unknown as ServiceDefinition;
    const reqDoc = preDefinition.requiredDocuments.find((doc) => doc.key === requirementKey);
    if (!reqDoc) {
      throw new AppException(
        'UNKNOWN_REQUIREMENT_KEY',
        `Requirement key "${requirementKey}" is not defined for this service.`,
        { field: 'requirementKey' },
      );
    }

    if (file.size > reqDoc.maxSizeBytes) {
      throw new AppException(
        'FILE_TOO_LARGE',
        `File exceeds maximum allowed size of ${reqDoc.maxSizeBytes} bytes.`,
      );
    }

    const detectedMime = sniffAllowedMimeType(file.buffer);
    if (!detectedMime || !reqDoc.allowedMimeTypes.includes(detectedMime)) {
      throw new AppException(
        'UNSUPPORTED_FILE_TYPE',
        'Detected file type is not allowed for this document requirement.',
      );
    }

    const declaredMime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (declaredMime !== detectedMime) {
      throw new AppException(
        'FILE_CONTENT_MISMATCH',
        'Uploaded file content does not match its declared Content-Type.',
      );
    }

    // 2. Persist bytes outside any DB transaction under a generated key.
    const ext = extensionForMimeType(detectedMime);
    const newStorageKey = `applications/${applicationId}/${randomUUID()}.${ext}`;
    const originalName = sanitizeOriginalName(file.originalname || `document.${ext}`);

    await this.storageDriver.put(newStorageKey, file.buffer, detectedMime);

    // 3. Lock application row (D-25) and upsert metadata atomically; clean up new object on failure.
    let previousStorageKey: string | null = null;
    try {
      const saved = await withTx(this.prisma, async (tx) => {
        const exists = await lockApplication(tx, applicationId);
        if (!exists) {
          throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
        }

        const lockedApp = await tx.applications.findFirst({
          where: { id: applicationId, citizen_id: citizen.id },
          include: { services: true },
        });
        if (!lockedApp) {
          throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
        }
        if (lockedApp.status !== 'DRAFT') {
          throw new AppException(
            'APPLICATION_NOT_EDITABLE',
            'Attachments can only be uploaded to DRAFT applications.',
          );
        }
        if (
          lockedApp.services.availability !== 'PUBLISHED' ||
          lockedApp.services.published_version === null
        ) {
          throw new AppException('SERVICE_NOT_AVAILABLE', 'Service is no longer published.');
        }

        const liveVersion = await tx.service_versions.findUniqueOrThrow({
          where: {
            service_id_version: {
              service_id: lockedApp.service_id,
              version: lockedApp.services.published_version,
            },
          },
        });
        const liveDef = liveVersion.definition as unknown as ServiceDefinition;
        if (!liveDef.requiredDocuments.some((doc) => doc.key === requirementKey)) {
          throw new AppException(
            'UNKNOWN_REQUIREMENT_KEY',
            `Requirement key "${requirementKey}" is not defined for this service.`,
            { field: 'requirementKey' },
          );
        }

        const existing = await tx.attachments.findUnique({
          where: {
            application_id_requirement_key: {
              application_id: applicationId,
              requirement_key: requirementKey,
            },
          },
        });

        if (existing) {
          previousStorageKey = existing.storage_key;
          return tx.attachments.update({
            where: { id: existing.id },
            data: {
              original_name: originalName,
              mime_type: detectedMime,
              size_bytes: file.size,
              storage_key: newStorageKey,
              uploaded_at: new Date(),
            },
          });
        }

        return tx.attachments.create({
          data: {
            application_id: applicationId,
            requirement_key: requirementKey,
            original_name: originalName,
            mime_type: detectedMime,
            size_bytes: file.size,
            storage_key: newStorageKey,
          },
        });
      });

      // 4. Delete replaced file after commit only.
      if (previousStorageKey) {
        await this.storageDriver.delete(previousStorageKey);
      }

      return mapAttachmentResponse(saved);
    } catch (error) {
      await this.storageDriver.delete(newStorageKey);
      throw error;
    }
  }

  async streamFile(
    user: AuthenticatedUser,
    applicationId: string,
    attachmentId: string,
    res: Response,
  ): Promise<void> {
    if (!isUuid(applicationId)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const app = await this.prisma.applications.findFirst({
      where:
        user.role === 'ADMIN' ? { id: applicationId } : { id: applicationId, citizen_id: user.id },
      select: { id: true },
    });
    if (!app) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    if (!isUuid(attachmentId)) {
      throw new AppException('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
    }

    const attachment = await this.prisma.attachments.findFirst({
      where: { id: attachmentId, application_id: applicationId },
    });
    if (!attachment) {
      throw new AppException('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
    }

    const stream = await this.storageDriver.getStream(attachment.storage_key);

    // Contract §4.10 & Design D-26 hardening headers
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Disposition', buildInlineContentDisposition(attachment.original_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Origin');

    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      stream.pipe(res);
    });
  }

  async deleteAttachment(
    citizen: AuthenticatedUser,
    applicationId: string,
    attachmentId: string,
  ): Promise<{ id: string; deleted: true }> {
    if (!isUuid(applicationId)) {
      throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
    }

    const storageKey = await withTx(this.prisma, async (tx) => {
      const exists = await lockApplication(tx, applicationId);
      if (!exists) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }

      const app = await tx.applications.findFirst({
        where: { id: applicationId, citizen_id: citizen.id },
      });
      if (!app) {
        throw new AppException('APPLICATION_NOT_FOUND', 'Application not found.');
      }
      if (app.status !== 'DRAFT') {
        throw new AppException(
          'APPLICATION_NOT_EDITABLE',
          'Attachments can only be deleted from DRAFT applications.',
        );
      }

      if (!isUuid(attachmentId)) {
        throw new AppException('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      }

      const attachment = await tx.attachments.findFirst({
        where: { id: attachmentId, application_id: applicationId },
      });
      if (!attachment) {
        throw new AppException('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      }

      await tx.attachments.delete({ where: { id: attachment.id } });
      return attachment.storage_key;
    });

    await this.storageDriver.delete(storageKey);

    return { id: attachmentId, deleted: true };
  }
}
