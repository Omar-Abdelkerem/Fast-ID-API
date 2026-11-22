import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryStorageDriver } from './cloudinary.storage';
import { LocalDiskStorageDriver } from './local-disk.storage';
import { STORAGE_DRIVER, StorageDriver } from './storage-driver.interface';

@Global()
@Module({
  providers: [
    LocalDiskStorageDriver,
    CloudinaryStorageDriver,
    {
      provide: STORAGE_DRIVER,
      inject: [ConfigService, LocalDiskStorageDriver, CloudinaryStorageDriver],
      useFactory: (
        configService: ConfigService,
        localDriver: LocalDiskStorageDriver,
        cloudinaryDriver: CloudinaryStorageDriver,
      ): StorageDriver => {
        const driver = configService.get<string>('STORAGE_DRIVER', 'local');
        if (driver === 'cloudinary') {
          return cloudinaryDriver;
        }
        return localDriver;
      },
    },
  ],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
