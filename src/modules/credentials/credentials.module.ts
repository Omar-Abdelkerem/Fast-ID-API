import { Module } from '@nestjs/common';
import { AdminCredentialsController } from './admin-credentials.controller';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { VerifyController } from './verify.controller';

@Module({
  controllers: [CredentialsController, VerifyController, AdminCredentialsController],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
