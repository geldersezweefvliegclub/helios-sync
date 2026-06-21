import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { ApiService, HELIOS_CREDENTIAL_FILE } from './api.service';

interface HeliosConfig {
  url: string;
  username: string;
  password: string;
  token?: string;
}

interface BearerToken {
  TOKEN: string;
}

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(private readonly api: ApiService) {}

  async login(): Promise<void> {
    const file = process.env.HELIOS_CREDENTIAL_FILE || HELIOS_CREDENTIAL_FILE;
    const config = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, { encoding: 'utf8' })) as HeliosConfig)
      : undefined;

    if (!config) {
      throw new Error(`Helios credential file niet gevonden: ${file}`);
    }

    const headers = new Headers({
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
    });

    const params: Record<string, string> = {};
    if (config.token) {
      params.token = createHash('sha1').update(config.token + config.password, 'utf8').digest('hex');
    }

    const login = await this.api.get<BearerToken>('Login/Login', params, headers);
    this.api.setBearerToken(login.TOKEN);
    this.logger.verbose('Ingelogd bij Helios');
  }
}