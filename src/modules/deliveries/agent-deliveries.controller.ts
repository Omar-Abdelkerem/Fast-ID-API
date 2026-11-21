import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { UserRateLimit } from '../../common/guards/user-rate-limit.guard';
import { DeliveriesService } from './deliveries.service';
import { AdminDeliveryResponse } from './delivery-response.mapper';
import { DeliverDeliveryDto } from './dto/deliver-delivery.dto';
import { FailDeliveryDto } from './dto/fail-delivery.dto';
import { ListAgentDeliveriesQueryDto } from './dto/list-agent-deliveries-query.dto';

@Roles('AGENT')
@Controller('agent/deliveries')
export class AgentDeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Get()
  async list(
    @CurrentUser() agent: AuthenticatedUser,
    @Query() query: ListAgentDeliveriesQueryDto,
  ): Promise<PaginatedResult<AdminDeliveryResponse>> {
    return this.deliveriesService.listAgent(agent, query);
  }

  @Get(':id')
  async getById(
    @CurrentUser() agent: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.getAgentById(agent, id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @CurrentUser() agent: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.startDelivery(agent, id);
  }

  @UserRateLimit({ name: 'agent-deliver', limit: 20, windowMs: 60_000 })
  @Post(':id/deliver')
  @HttpCode(HttpStatus.OK)
  async deliver(
    @CurrentUser() agent: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeliverDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.completeDelivery(agent, id, dto);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  async fail(
    @CurrentUser() agent: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FailDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.failDelivery(agent, id, dto);
  }
}
