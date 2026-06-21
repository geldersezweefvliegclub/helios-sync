import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleService } from '../google/google.service';

@Injectable()
export class ErrorMailService {
  private readonly logger = new Logger(ErrorMailService.name);

  constructor(
    private readonly googleService: GoogleService,
    private readonly configService: ConfigService,
  ) {}

  async sendSyncError(subject: string, error: unknown): Promise<void> {
    const ictEmail = this.configService.get<string>('ICT_EMAIL', 'ict@gezc.org');
    const errorMessage = error instanceof Error
      ? `${error.message}\n\n${error.stack ?? ''}`
      : String(error);

    this.logger.log(`Sending error email to ${ictEmail}: ${subject}`);

    const html = this.buildErrorHtml(subject, this.nl2br(errorMessage));

    try {
      await this.googleService.sendHtmlEmail({
        to: ictEmail,
        subject: `[helios-sync] ${subject}`,
        html,
      });
    } catch (mailError) {
      this.logger.error(`Failed to send error email: ${mailError}`);
    }
  }

  private buildErrorHtml(titel: string, inhoud: string): string {
    return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:800px">
  <h2 style="color:#c00">${this.escapeHtml(titel)}</h2>
  <p>${inhoud}</p>
</body>
</html>`;
  }

  private nl2br(value?: string): string {
    return this.escapeHtml(value).replace(/\r?\n/g, '<br />');
  }

  private escapeHtml(value?: string): string {
    return (value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
