import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditLogResponse } from './audit-log-response.mapper';
import { AuditService } from './audit.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@Roles('ADMIN')
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(@Query() query: ListAuditLogsQueryDto): Promise<PaginatedResult<AuditLogResponse>> {
    return this.auditService.list(query);
  }
}
