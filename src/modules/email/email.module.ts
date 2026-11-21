import { Global, Module } from '@nestjs/common';
import { EmailOutboxWorker } from './email-outbox.worker';
import { EMAIL_PROVIDER } from './email-provider.interface';
import { EmailService } from './email.service';
import { LogEmailProvider } from './log-email.provider';

@Global()
@Module({
  providers: [
    EmailService,
    LogEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useExisting: LogEmailProvider,
    },
    EmailOutboxWorker,
  ],
  exports: [EmailService, EmailOutboxWorker, EMAIL_PROVIDER],
})
export class EmailModule {}
