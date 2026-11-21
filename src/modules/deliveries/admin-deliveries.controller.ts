import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { DeliveriesService } from './deliveries.service';
import { AdminDeliveryResponse } from './delivery-response.mapper';
import { AssignDeliveryDto } from './dto/assign-delivery.dto';
import { ListAdminDeliveriesQueryDto } from './dto/list-admin-deliveries-query.dto';

@Roles('ADMIN')
@Controller('admin/deliveries')
export class AdminDeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Get()
  async list(
    @Query() query: ListAdminDeliveriesQueryDto,
  ): Promise<PaginatedResult<AdminDeliveryResponse>> {
    return this.deliveriesService.listAdmin(query);
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.getAdminById(id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  async assign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignDeliveryDto,
  ): Promise<AdminDeliveryResponse> {
    return this.deliveriesService.assign(admin, id, dto);
  }
}
