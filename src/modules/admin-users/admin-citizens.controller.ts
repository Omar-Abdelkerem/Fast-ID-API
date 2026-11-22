import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AdminCitizensService } from './admin-citizens.service';
import { AdminCitizenResponse } from './citizen-response.mapper';
import { ListCitizensQueryDto } from './dto/list-citizens-query.dto';
import { UpdateCitizenDto } from './dto/update-citizen.dto';

@Roles('ADMIN')
@Controller('admin/citizens')
export class AdminCitizensController {
  constructor(private readonly citizensService: AdminCitizensService) {}

  @Get()
  async list(@Query() query: ListCitizensQueryDto): Promise<PaginatedResult<AdminCitizenResponse>> {
    return this.citizensService.list(query);
  }

  @Patch(':id')
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCitizenDto,
  ): Promise<AdminCitizenResponse> {
    return this.citizensService.update(admin, id, dto);
  }
}
