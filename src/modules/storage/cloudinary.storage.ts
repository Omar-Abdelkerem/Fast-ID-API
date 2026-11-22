import { Readable } from 'stream';
import { ReadableStream as NodeWebReadableStream } from 'stream/web';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { StorageDriver } from './storage-driver.interface';

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export function parseCloudinaryCredentials(params: {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  cloudinaryUrl?: string;
}): CloudinaryCredentials {
  if (params.cloudName && params.apiKey && params.apiSecret) {
    return {
      cloudName: params.cloudName,
      apiKey: params.apiKey,
      apiSecret: params.apiSecret,
    };
  }

  if (params.cloudinaryUrl) {
    const parsed = new URL(params.cloudinaryUrl);
    if (
      parsed.protocol !== 'cloudinary:' ||
      !parsed.username ||
      !parsed.password ||
      !parsed.hostname
    ) {
      throw new Error('Invalid CLOUDINARY_URL format.');
    }
    return {
      cloudName: decodeURIComponent(parsed.hostname),
      apiKey: decodeURIComponent(parsed.username),
      apiSecret: decodeURIComponent(parsed.password),
    };
  }

  throw new Error('Cloudinary credentials are not configured.');
}

/**
 * Private Cloudinary storage driver (Contract §4.9, §4.10, Appendix A.4):
 * - Stores attachments as `resource_type: 'raw'` + `type: 'authenticated'` so bytes are preserved
 *   verbatim (JPEG, PNG, PDF) and never exposed at unsigned public URLs.
 * - Downloads use a short-lived signed private download URL fetched server-side and streamed
 *   through the authenticated §4.10 endpoint with CSP sandbox & nosniff headers.
 * - Never called inside a database transaction.
 */
@Injectable()
export class CloudinaryStorageDriver implements StorageDriver {
  private readonly logger = new Logger(CloudinaryStorageDriver.name);
  private readonly folderPrefix: string;
  private readonly configured: boolean;

  constructor(private readonly configService: ConfigService) {
    const rawFolder = this.configService.get<string>('CLOUDINARY_FOLDER', 'fast-id');
    this.folderPrefix = rawFolder.replace(/^\/+|\/+$/g, '');

    const driver = this.configService.get<string>('STORAGE_DRIVER');
    if (driver === 'cloudinary') {
      const creds = parseCloudinaryCredentials({
        cloudName: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
        apiKey: this.configService.get<string>('CLOUDINARY_API_KEY'),
        apiSecret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
        cloudinaryUrl: this.configService.get<string>('CLOUDINARY_URL'),
      });
      cloudinary.config({
        cloud_name: creds.cloudName,
        api_key: creds.apiKey,
        api_secret: creds.apiSecret,
        secure: true,
      });
      this.configured = true;
    } else {
      this.configured = false;
    }
  }

  buildPublicId(key: string): string {
    const normalized = key
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
      .join('/');

    if (!normalized) {
      throw new Error('Invalid storage key.');
    }

    return this.folderPrefix ? `${this.folderPrefix}/${normalized}` : normalized;
  }

  async put(key: string, buffer: Buffer, _mimeType: string): Promise<void> {
    this.assertConfigured();
    const publicId = this.buildPublicId(key);

    await new Promise<void>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: 'raw',
          type: 'authenticated',
          overwrite: true,
          invalidate: true,
        },
        (error) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
            return;
          }
          resolve();
        },
      );

      uploadStream.on('error', (err) => {
        reject(new Error(`Cloudinary upload stream failed: ${err.message}`));
      });

      uploadStream.end(buffer);
    });
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    this.assertConfigured();
    const publicId = this.buildPublicId(key);
    const expiresAt = Math.floor(Date.now() / 1000) + 60;

    const signedUrl = cloudinary.utils.private_download_url(publicId, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: expiresAt,
    });

    const response = await fetch(signedUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Cloudinary download failed with status ${response.status}.`);
    }

    return Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  }

  async delete(key: string): Promise<void> {
    if (!this.configured) {
      return;
    }

    const publicId = this.buildPublicId(key);
    try {
      const result = (await cloudinary.uploader.destroy(publicId, {
        resource_type: 'raw',
        type: 'authenticated',
        invalidate: true,
      })) as { result?: string };

      if (result?.result && result.result !== 'ok' && result.result !== 'not found') {
        this.logger.warn({ msg: 'Unexpected Cloudinary delete result', result: result.result });
      }
    } catch {
      this.logger.warn({ msg: 'Failed to delete Cloudinary storage object' });
    }
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('CloudinaryStorageDriver is not configured.');
    }
  }
}
