import { Module } from '@nestjs/common';
import { AdminCitizensController } from './admin-citizens.controller';
import { AdminCitizensService } from './admin-citizens.service';
import { AdminStaffController } from './admin-staff.controller';
import { AdminStaffService } from './admin-staff.service';

@Module({
  controllers: [AdminStaffController, AdminCitizensController],
  providers: [AdminStaffService, AdminCitizensService],
})
export class AdminUsersModule {}
