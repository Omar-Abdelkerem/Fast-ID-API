import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider, RenderedEmail } from './email-provider.interface';

/**
 * Development/test email driver (EMAIL_DRIVER=log, Design §5.7, §9).
 * Logs structured metadata only — never logs personal data, passwords, or reset tokens.
 */
@Injectable()
export class LogEmailProvider implements EmailProvider {
  private readonly logger = new Logger(LogEmailProvider.name);

  async send(email: RenderedEmail): Promise<void> {
    this.logger.log({
      msg: 'Email dispatched via log driver',
      template: email.template,
      language: email.language,
      subject: email.subject,
    });
  }
}
