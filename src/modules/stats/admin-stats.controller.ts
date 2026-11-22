import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminStatsResponse, StatsService } from './stats.service';

@Roles('ADMIN')
@Controller('admin/stats')
export class AdminStatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  async getStats(): Promise<AdminStatsResponse> {
    return this.statsService.getAdminStats();
  }
}
