import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { StoredToken, SynapseTokenResponse } from './synapse.types';

@Injectable()
export class SynapseAuthService {
  private readonly logger = new Logger(SynapseAuthService.name);

  constructor(private readonly configService: ConfigService) {}

  async getAdminToken(): Promise<string> {
    const stored = this.loadStoredToken();

    if (stored) {
      if (Date.now() < stored.expires_at) {
        return stored.access_token;
      }

      if (stored.refresh_token) {
        try {
          return await this.refreshToken(stored.refresh_token);
        } catch (err) {
          this.logger.warn(`Token refresh failed, re-logging in: ${err}`);
          this.deleteToken();
        }
      } else {
        this.deleteToken();
      }
    }

    return this.login();
  }

  async getUserToken(username: string, password: string): Promise<string> {
    return this.login(username, password);
  }

  async handleUnauthorized(): Promise<void> {
    this.logger.warn('Received 401 M_UNKNOWN_TOKEN, deleting stored token');
    this.deleteToken();
  }

  private async login(username?: string, password?: string): Promise<string> {
    const synapseUrl = this.configService.getOrThrow<string>('SYNAPSE_URL');
    const adminUser = this.configService.getOrThrow<string>('SYNAPSE_ADMIN_USER');
    const adminPassword = this.configService.getOrThrow<string>('SYNAPSE_ADMIN_PASSWORD');

    const loginUrl = `${synapseUrl}_matrix/client/r0/login`;
    const body = {
      type: 'm.login.password',
      refresh_token: true,
      user: username ?? adminUser,
      password: password ?? adminPassword,
    };

    this.logger.debug(`Logging in to Synapse as ${username ?? adminUser}`);

    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Synapse login failed: ${response.status} ${text}`);
    }

    const data = await response.json() as SynapseTokenResponse;

    if (!username) {
      // Persist admin token
      const stored: StoredToken = {
        ...data,
        expires_at: Date.now() + 5 * 60 * 1000,
      };
      this.saveToken(stored);
    }

    return data.access_token;
  }

  private async refreshToken(refreshToken: string): Promise<string> {
    const synapseUrl = this.configService.getOrThrow<string>('SYNAPSE_URL');
    const refreshUrl = `${synapseUrl}_matrix/client/r0/refresh`;

    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${text}`);
    }

    const data = await response.json() as SynapseTokenResponse;
    const stored: StoredToken = {
      ...data,
      expires_at: data.expires_in_ms
        ? Date.now() + data.expires_in_ms - 10_000
        : Date.now() + 5 * 60 * 1000,
    };
    this.saveToken(stored);
    return stored.access_token;
  }

  private loadStoredToken(): StoredToken | null {
    const tokenFile = this.configService.get<string>('SYNAPSE_TOKEN_FILE', './synapse-token.json');
    try {
      if (fs.existsSync(tokenFile)) {
        const content = fs.readFileSync(tokenFile, 'utf-8');
        return JSON.parse(content) as StoredToken;
      }
    } catch (err) {
      this.logger.warn(`Failed to read token file: ${err}`);
    }
    return null;
  }

  private saveToken(token: StoredToken): void {
    const tokenFile = this.configService.get<string>('SYNAPSE_TOKEN_FILE', './synapse-token.json');
    try {
      fs.writeFileSync(tokenFile, JSON.stringify(token), 'utf-8');
    } catch (err) {
      this.logger.warn(`Failed to save token file: ${err}`);
    }
  }

  deleteToken(): void {
    const tokenFile = this.configService.get<string>('SYNAPSE_TOKEN_FILE', './synapse-token.json');
    try {
      if (fs.existsSync(tokenFile)) {
        fs.unlinkSync(tokenFile);
      }
    } catch (err) {
      this.logger.warn(`Failed to delete token file: ${err}`);
    }
  }
}
