import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';

export const HELIOS_CREDENTIAL_FILE = 'helios.account.json';

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private readonly baseUrl: string;
  private bearerToken: string | null = null;

  constructor() {
    const file = process.env.HELIOS_CREDENTIAL_FILE || HELIOS_CREDENTIAL_FILE;
    const helios = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, { encoding: 'utf8' })) as { url?: string })
      : undefined;

    if (!helios?.url) {
      throw new Error(`Helios credential file niet gevonden of url ontbreekt: ${file}`);
    }

    const url = helios.url;
    this.baseUrl = url.endsWith('/') ? url : `${url}/`;
  }

  setBearerToken(token?: string): void {
    this.bearerToken = token ?? null;
  }

  async get<T>(path: string, params?: Record<string, string>, headers?: Headers): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    this.logger.debug(`GET ${url}`);
    const reqHeaders = headers ?? new Headers();
    if (!reqHeaders.has('Authorization') && this.bearerToken) {
      reqHeaders.set('Authorization', `Bearer ${this.bearerToken}`);
    }
    const response = await fetch(url, { headers: reqHeaders });
    if (!response.ok) {
      throw new Error(`Helios GET ${path} mislukt: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async post(path: string, body: unknown): Promise<Response> {
    const response = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Helios POST ${path} mislukt: ${response.status}`);
    }
    return response;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.bearerToken) h['Authorization'] = `Bearer ${this.bearerToken}`;
    return h;
  }
}