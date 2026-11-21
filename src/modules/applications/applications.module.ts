import { Module } from '@nestjs/common';
import { ApplicationWorkflowService } from './application-workflow.service';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  controllers: [ApplicationsController],
  providers: [ApplicationWorkflowService, ApplicationsService],
  exports: [ApplicationWorkflowService, ApplicationsService],
})
export class ApplicationsModule {}
