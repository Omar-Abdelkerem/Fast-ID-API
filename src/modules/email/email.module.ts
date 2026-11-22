import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CleanupJob } from './cleanup.job';
import { EmailOutboxWorker } from './email-outbox.worker';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';
import { EmailService } from './email.service';
import { LogEmailProvider } from './log-email.provider';
import { ResendEmailProvider } from './resend-email.provider';

@Global()
@Module({
  providers: [
    EmailService,
    LogEmailProvider,
    ResendEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService, LogEmailProvider, ResendEmailProvider],
      useFactory: (
        configService: ConfigService,
        logProvider: LogEmailProvider,
        resendProvider: ResendEmailProvider,
      ): EmailProvider => {
        const driver = configService.get<string>('EMAIL_DRIVER', 'log');
        return driver === 'resend' ? resendProvider : logProvider;
      },
    },
    EmailOutboxWorker,
    CleanupJob,
  ],
  exports: [EmailService, EmailOutboxWorker, CleanupJob, EMAIL_PROVIDER],
})
export class EmailModule {}
