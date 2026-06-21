import { Injectable, Logger } from '@nestjs/common';
import { gmail_v1, google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as fs from 'node:fs';

@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly credentials: any;

  constructor() {
    const path = process.env.GOOGLE_CREDENTIALS_PATH;
    this.credentials = path && fs.existsSync(path)
      ? JSON.parse(fs.readFileSync(path, { encoding: 'utf8' }))
      : undefined;
  }

  private async getGmailApi(): Promise<gmail_v1.Gmail> {
    if (!this.credentials) {
      throw new Error('Google credentials not found');
    }

    const authClient = new JWT({
      email: this.credentials.client_email,
      key: this.credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: process.env.GOOGLE_ADMIN_EMAIL,
    });

    return google.gmail({ version: 'v1', auth: authClient });
  }

  private base64UrlEncode(str: string): string {
    return Buffer.from(str)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async sendHtmlEmail({
    to,
    subject,
    html,
    cc,
    bcc,
  }: {
    to?: string;
    subject: string;
    html: string;
    cc?: string[];
    bcc?: string[];
  }): Promise<void> {
    if (process.env.VERZENDEN_EMAIL === 'false') {
      this.logger.log(`Email sending disabled. Would send to: to=${to}, cc=${cc}, bcc=${bcc}`);
      return;
    }

    const gmail = await this.getGmailApi();
    const headers = [`From: ${process.env.GOOGLE_ADMIN_EMAIL}`];

    if (to) headers.push(`To: ${to}`);
    if (cc?.length) headers.push(`Cc: ${cc.join(', ')}`);
    if (bcc?.length) headers.push(`Bcc: ${bcc.join(', ')}`);

    headers.push(`Subject: ${subject}`);
    headers.push('MIME-Version: 1.0');
    headers.push('Content-Type: text/html; charset=UTF-8');

    const raw = this.base64UrlEncode(`${headers.join('\n')}\n\n${html}`);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
  }
}
