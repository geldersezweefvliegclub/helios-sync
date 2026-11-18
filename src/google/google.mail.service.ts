import { Injectable, Logger } from '@nestjs/common';
import { gmail_v1, google } from 'googleapis';
import { GoogleServiceAccount, laadGoogleCredentials, maakGoogleAuthClient } from './google.credentials';

/**
 * Verstuurt e-mail via de Gmail API, namens GOOGLE_ADMIN_EMAIL.
 *
 * Vereist dat het service account domain-wide delegation heeft voor de scope
 * https://www.googleapis.com/auth/gmail.send.
 */
@Injectable()
export class GoogleMailService {
  private readonly logger = new Logger(GoogleMailService.name);
  private readonly credentials: GoogleServiceAccount | undefined = laadGoogleCredentials();

  /** Gmail client die namens GOOGLE_ADMIN_EMAIL mag versturen */
  private async getGmailApi(): Promise<gmail_v1.Gmail> {
    const authClient = maakGoogleAuthClient(
      this.credentials,
      ['https://www.googleapis.com/auth/gmail.send'],
      process.env.GOOGLE_ADMIN_EMAIL,
    );

    return google.gmail({ version: 'v1', auth: authClient });
  }

  /** De Gmail API verwacht het bericht als base64url (RFC 4648 §5) zonder padding */
  private base64UrlEncode(str: string): string {
    return Buffer.from(str)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Verstuurt een HTML e-mail. Met VERZENDEN_EMAIL=false wordt alleen gelogd wat er
   * verstuurd zou worden (handig voor test / ontwikkeling).
   */
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

    // Ruw RFC 2822 bericht: headers, lege regel, body
    const raw = this.base64UrlEncode(`${headers.join('\n')}\n\n${html}`);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
  }
}
