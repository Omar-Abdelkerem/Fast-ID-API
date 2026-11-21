import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { AdminServiceResponse, ServiceVersionResponse } from './service-definition.types';
import { ServicesService } from './services.service';

@Roles('ADMIN')
@Controller('admin/services')
export class AdminServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  async listAdmin(): Promise<AdminServiceResponse[]> {
    return this.servicesService.listAdmin();
  }

  @Get(':id')
  async getAdmin(@Param('id') id: string): Promise<AdminServiceResponse> {
    return this.servicesService.getAdminById(id);
  }

  @Get(':id/versions/:version')
  async getVersion(
    @Param('id') id: string,
    @Param('version') version: string,
  ): Promise<ServiceVersionResponse> {
    return this.servicesService.getVersion(id, version);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminServiceResponse> {
    return this.servicesService.create(admin.id, body);
  }

  @Patch(':id')
  async updateDraft(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AdminServiceResponse> {
    return this.servicesService.updateDraft(admin.id, id, body);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<AdminServiceResponse> {
    return this.servicesService.publish(admin.id, id);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  async unpublish(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<AdminServiceResponse> {
    return this.servicesService.unpublish(admin.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<{ id: string; deleted: true }> {
    return this.servicesService.delete(admin.id, id);
  }
}
