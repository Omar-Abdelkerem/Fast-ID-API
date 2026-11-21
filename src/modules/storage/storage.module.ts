import { Global, Module } from '@nestjs/common';
import { LocalDiskStorageDriver } from './local-disk.storage';
import { STORAGE_DRIVER } from './storage-driver.interface';

@Global()
@Module({
  providers: [
    LocalDiskStorageDriver,
    {
      provide: STORAGE_DRIVER,
      useExisting: LocalDiskStorageDriver,
    },
  ],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
