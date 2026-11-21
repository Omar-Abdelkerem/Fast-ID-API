import { Module } from '@nestjs/common';
import { AdminDeliveriesController } from './admin-deliveries.controller';
import { AgentDeliveriesController } from './agent-deliveries.controller';
import { DeliveriesService } from './deliveries.service';

@Module({
  controllers: [AdminDeliveriesController, AgentDeliveriesController],
  providers: [DeliveriesService],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
