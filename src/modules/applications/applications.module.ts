import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { AdminApplicationsController } from './admin-applications.controller';
import { AdminApplicationsService } from './admin-applications.service';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  imports: [CredentialsModule, DeliveriesModule],
  controllers: [ApplicationsController, AdminApplicationsController],
  providers: [ApplicationsService, AdminApplicationsService],
  exports: [ApplicationsService, AdminApplicationsService],
})
export class ApplicationsModule {}
