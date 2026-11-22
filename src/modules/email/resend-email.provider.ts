import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailProvider, RenderedEmail } from './email-provider.interface';

/**
 * Production email provider backed by Resend SDK (Design D-07, §5.7).
 */
@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly resend: Resend | null;
  private readonly fromAddress: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('EMAIL_PROVIDER_API_KEY');
    this.fromAddress = this.configService.get<string>('EMAIL_FROM', '');
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async send(email: RenderedEmail): Promise<void> {
    if (!this.resend || !this.fromAddress) {
      throw new Error('Resend email provider is not configured.');
    }

    const result = await this.resend.emails.send({
      from: this.fromAddress,
      to: [email.to],
      subject: email.subject,
      text: email.text,
    });

    if (result.error) {
      throw new Error(result.error.message || 'Resend API returned an error.');
    }
  }
}
