import { Module } from '@nestjs/common';
import { NotificationsBroadcasterService } from './notifications-broadcaster.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsBroadcasterService],
  exports: [NotificationsService, NotificationsBroadcasterService],
})
export class NotificationsModule {}
