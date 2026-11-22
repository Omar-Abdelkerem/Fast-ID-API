import { Global, Module } from '@nestjs/common';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AdminAuditLogsController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
