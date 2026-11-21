import { Global, Module } from '@nestjs/common';
import { NotificationsWriterService } from './notifications-writer.service';
import { SessionStreamRegistry } from './session-stream-registry';

@Global()
@Module({
  providers: [SessionStreamRegistry, NotificationsWriterService],
  exports: [SessionStreamRegistry, NotificationsWriterService],
})
export class NotificationsRegistryModule {}
