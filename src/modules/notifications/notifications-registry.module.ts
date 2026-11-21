import { Global, Module } from '@nestjs/common';
import { SessionStreamRegistry } from './session-stream-registry';

@Global()
@Module({
  providers: [SessionStreamRegistry],
  exports: [SessionStreamRegistry],
})
export class NotificationsRegistryModule {}
