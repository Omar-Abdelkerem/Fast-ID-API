import { Global, Module } from '@nestjs/common';
import { ApplicationWorkflowService } from './application-workflow.service';

@Global()
@Module({
  providers: [ApplicationWorkflowService],
  exports: [ApplicationWorkflowService],
})
export class WorkflowModule {}
