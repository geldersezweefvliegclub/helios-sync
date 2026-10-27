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
    const url = `${this.baseUrl}${path}`;
    this.logger.debug(`POST (binary) ${url}`);

    const send = async (authToken: string) => fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(data),
    });

    let authToken = await this.authService.getAdminToken();
    let response = await send(authToken);

    if (response.status === 401 && await this.isUnknownToken(response.clone())) {
      await this.authService.handleUnauthorized(authToken);
      this.logger.warn(`401 M_UNKNOWN_TOKEN op POST ${url}, opnieuw proberen met nieuw token`);
      authToken = await this.authService.getAdminToken();
      response = await send(authToken);
    }

    // Ook het opgeslagen token afgewezen: geforceerd opnieuw inloggen
    if (response.status === 401 && await this.isUnknownToken(response.clone())) {
      this.logger.warn(`401 M_UNKNOWN_TOKEN op POST ${url} na retry, geforceerd opnieuw inloggen`);
      authToken = await this.authService.forceNewAdminToken(authToken);
      response = await send(authToken);
    }

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
    const url = `${this.baseUrl}${path}`;
    this.logger.debug(`${method} ${url}`);

    const send = async (authToken: string) => fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let authToken = token ?? await this.authService.getAdminToken();
    let response = await send(authToken);

    // Admin token afgewezen: opnieuw inloggen en één keer opnieuw proberen
    if (!token && response.status === 401 && await this.isUnknownToken(response.clone())) {
      await this.authService.handleUnauthorized(authToken);
      this.logger.warn(`401 M_UNKNOWN_TOKEN op ${method} ${url}, opnieuw proberen met nieuw token`);
      authToken = await this.authService.getAdminToken();
      response = await send(authToken);

      // Ook het opgeslagen token afgewezen: geforceerd opnieuw inloggen
      if (response.status === 401 && await this.isUnknownToken(response.clone())) {
        this.logger.warn(`401 M_UNKNOWN_TOKEN op ${method} ${url} na retry, geforceerd opnieuw inloggen`);
        authToken = await this.authService.forceNewAdminToken(authToken);
        response = await send(authToken);
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        const text = await response.text();
        if (!token && this.parseErrcode(text) === 'M_UNKNOWN_TOKEN') {
          await this.authService.handleUnauthorized(authToken);
        }
        throw new Error(`Synapse API 401 on ${method} ${url}: ${text}`);
      }

      if (response.status === 404)
      {
        const text = await response.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = {}; }
        if (parsed.errcode === 'M_NOT_FOUND') {
          return undefined;
        }
      }

      await this.handleErrorResponse(response, url);
    }

    return response.json() as Promise<T>;
  }

  private async isUnknownToken(response: Response): Promise<boolean> {
    return this.parseErrcode(await response.text()) === 'M_UNKNOWN_TOKEN';
  }

  private parseErrcode(text: string): string | undefined {
    try { return JSON.parse(text)?.errcode; } catch { return undefined; }
  }

  private async handleErrorResponse(response: Response, url: string): Promise<never> {
    const body = await response.text();
    const message = `Synapse API error ${response.status} on ${url}: ${body}`;
    this.logger.error(message);
    throw new Error(message);
  }
}
