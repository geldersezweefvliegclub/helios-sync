import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SynapseAuthService } from './synapse-auth.service';

@Injectable()
export class SynapseApiService {
  private readonly logger = new Logger(SynapseApiService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: SynapseAuthService,
  ) {}

  get baseUrl(): string {
    const url = this.configService.getOrThrow<string>('SYNAPSE_URL');
    return url.endsWith('/') ? url : `${url}/`;
  }

  async get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>('GET', path, undefined, token);
  }

  async put<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>('PUT', path, body, token);
  }

  async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>('POST', path, body, token);
  }

  async postBinary<T>(path: string, data: Buffer, contentType: string): Promise<T> {
    const authToken = await this.authService.getAdminToken();
    const url = `${this.baseUrl}${path}`;
    this.logger.debug(`POST (binary) ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(data),
    });

    if (!response.ok) {
      await this.handleErrorResponse(response, url);
    }

    return response.json() as Promise<T>;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    token?: string,
  ): Promise<T> {
    const authToken = token ?? await this.authService.getAdminToken();
    const url = `${this.baseUrl}${path}`;
    this.logger.debug(`${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401) {
        const text = await response.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = {}; }
        if (parsed.errcode === 'M_UNKNOWN_TOKEN') {
          await this.authService.handleUnauthorized();
        }
        throw new Error(`Synapse API 401 on ${method} ${url}: ${text}`);
      }
      await this.handleErrorResponse(response, url);
    }

    return response.json() as Promise<T>;
  }

  private async handleErrorResponse(response: Response, url: string): Promise<never> {
    const body = await response.text();
    const message = `Synapse API error ${response.status} on ${url}: ${body}`;
    this.logger.error(message);
    throw new Error(message);
  }
}
