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
  Query,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmptyBodyDto } from '../../common/dto/empty-body.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { CitizenApplicationResponse } from './application-response.mapper';
import { ApplicationsService } from './applications.service';
import { CancelApplicationDto } from './dto/cancel-application.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';

@Roles('CITIZEN')
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() citizen: AuthenticatedUser,
    @Body() dto: CreateApplicationDto,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.createDraft(citizen, dto);
  }

  @Get()
  async list(
    @CurrentUser() citizen: AuthenticatedUser,
    @Query() query: ListApplicationsQueryDto,
  ): Promise<PaginatedResult<CitizenApplicationResponse>> {
    return this.applicationsService.listForCitizen(citizen, query);
  }

  @Get(':id')
  async getById(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.getByIdForCitizen(citizen, id);
  }

  @Patch(':id')
  async updateDraft(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.updateDraft(citizen, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteDraft(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<{ id: string; deleted: true }> {
    return this.applicationsService.deleteDraft(citizen, id);
  }

  @Post(':id/payment/mock')
  @HttpCode(HttpStatus.OK)
  async mockPay(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.mockPay(citizen, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _body: EmptyBodyDto,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.submit(citizen, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() citizen: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelApplicationDto,
  ): Promise<CitizenApplicationResponse> {
    return this.applicationsService.cancel(citizen, id, dto);
  }
}
