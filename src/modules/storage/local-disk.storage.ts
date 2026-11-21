import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { StorageDriver } from './storage-driver.interface';

@Injectable()
export class LocalDiskStorageDriver implements StorageDriver {
  private readonly logger = new Logger(LocalDiskStorageDriver.name);
  private readonly rootDir: string;

  constructor(private readonly configService: ConfigService) {
    const configured = this.configService.get<string>('STORAGE_LOCAL_PATH', './storage');
    this.rootDir = path.resolve(configured);
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    const filePath = this.resolveSafePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolveSafePath(key);
    await fs.promises.access(filePath, fs.constants.R_OK);
    return fs.createReadStream(filePath);
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = this.resolveSafePath(key);
      await fs.promises.unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        this.logger.warn({ msg: 'Failed to delete local storage object', code });
      }
    }
  }

  private resolveSafePath(key: string): string {
    const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.resolve(this.rootDir, normalized);
    if (!fullPath.startsWith(this.rootDir + path.sep) && fullPath !== this.rootDir) {
      throw new Error('Invalid storage key path.');
    }
    return fullPath;
  }
}
