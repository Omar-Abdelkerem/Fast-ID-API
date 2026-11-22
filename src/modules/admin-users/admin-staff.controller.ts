import {
  Body,
  Controller,
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
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { UserResponse } from '../auth/user-response.mapper';
import { AdminStaffService } from './admin-staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Roles('ADMIN')
@Controller('admin/staff')
export class AdminStaffController {
  constructor(private readonly staffService: AdminStaffService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateStaffDto,
  ): Promise<UserResponse> {
    return this.staffService.create(admin, dto);
  }

  @Get()
  async list(@Query() query: ListStaffQueryDto): Promise<PaginatedResult<UserResponse>> {
    return this.staffService.list(query);
  }

  @Patch(':id')
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ): Promise<UserResponse> {
    return this.staffService.update(admin, id, dto);
  }
}
