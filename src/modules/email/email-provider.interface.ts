import { email_template, language_code } from '@prisma/client';

export interface RenderedEmail {
  to: string;
  template: email_template;
  language: language_code;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(email: RenderedEmail): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
