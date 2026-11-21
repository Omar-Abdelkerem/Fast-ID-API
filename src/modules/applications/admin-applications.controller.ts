import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import {
  AdminApplicationListItemResponse,
  AdminApplicationResponse,
} from './admin-application-response.mapper';
import { AdminApplicationsService } from './admin-applications.service';
import { ApproveApplicationDto } from './dto/approve-application.dto';
import { ListAdminApplicationsQueryDto } from './dto/list-admin-applications-query.dto';
import { RejectApplicationDto } from './dto/reject-application.dto';

@Roles('ADMIN')
@Controller('admin/applications')
export class AdminApplicationsController {
  constructor(private readonly adminApplicationsService: AdminApplicationsService) {}

  @Get()
  async list(
    @Query() query: ListAdminApplicationsQueryDto,
  ): Promise<PaginatedResult<AdminApplicationListItemResponse>> {
    return this.adminApplicationsService.list(query);
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<AdminApplicationResponse> {
    return this.adminApplicationsService.getById(id);
  }

  @Post(':id/start-review')
  @HttpCode(HttpStatus.OK)
  async startReview(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<AdminApplicationResponse> {
    return this.adminApplicationsService.startReview(admin, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveApplicationDto,
  ): Promise<AdminApplicationResponse> {
    return this.adminApplicationsService.approve(admin, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectApplicationDto,
  ): Promise<AdminApplicationResponse> {
    return this.adminApplicationsService.reject(admin, id, dto);
  }
}
