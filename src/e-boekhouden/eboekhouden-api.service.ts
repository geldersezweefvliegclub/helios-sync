import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EbMemberSummary {
  id: number;
  memberNumber: string;
  name: string;
}

export interface EbMember {
  id: number;
  memberNumber: string;
  name: string;
  salutation?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  phoneNumber?: string;
  mobilePhoneNumber?: string;
  emailAddress?: string;
  freeText1?: string;  // stores Helios ID
}

export interface EbMemberBody {
  memberNumber?: string;
  name: string;
  salutation?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  phoneNumber?: string;
  mobilePhoneNumber?: string;
  emailAddress?: string;
  freeText1?: string;  // Helios ID
}

@Injectable()
export class EboekhoudenApiService {
  private readonly logger = new Logger(EboekhoudenApiService.name);
  private sessionToken: string | null = null;
  private sessionExpiry: number = 0;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    const url = this.config.getOrThrow<string>('EB_BASE_URL');
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  private async getSessionToken(): Promise<string> {
    if (this.sessionToken && Date.now() < this.sessionExpiry) {
      return this.sessionToken;
    }

    const accessToken = this.config.getOrThrow<string>('EB_ACCESS_TOKEN');
    const source = this.config.get<string>('EB_SOURCE', 'helios');

    this.logger.debug('Opening new eBoekhouden session');
    const response = await fetch(`${this.baseUrl}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, source }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`eBoekhouden session failed ${response.status}: ${body}`);
    }

    const data = await response.json() as { token: string; expiresIn: number };
    this.sessionToken = data.token;
    // Refresh 60s before expiry
    this.sessionExpiry = Date.now() + (data.expiresIn - 60) * 1000;
    return this.sessionToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getSessionToken();
    const url = `${this.baseUrl}${path}`;

    this.logger.debug(`${method} ${url}`);
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`eBoekhouden ${method} ${path} failed ${response.status}: ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async findMemberByNumber(memberNumber: string): Promise<EbMemberSummary | null> {
    const result = await this.request<{ items: EbMemberSummary[]; count: number }>(
      'GET',
      `/v1/member?memberNumber=${encodeURIComponent(memberNumber)}&limit=1`,
    );
    return result.items[0] ?? null;
  }

  async getMember(id: number): Promise<EbMember> {
    return this.request<EbMember>('GET', `/v1/member/${id}`);
  }

  async createMember(body: EbMemberBody): Promise<EbMember> {
    return this.request<EbMember>('POST', '/v1/member', body);
  }

  async updateMember(id: number, body: EbMemberBody): Promise<void> {
    await this.request<void>('PATCH', `/v1/member/${id}`, body);
  }

  /** Fetch all members, paged. Returns the full list. */
  async getAllMembers(): Promise<EbMemberSummary[]> {
    const PAGE = 2000;
    const all: EbMemberSummary[] = [];
    let offset = 0;

    while (true) {
      const result = await this.request<{ items: EbMemberSummary[]; count: number }>(
        'GET',
        `/v1/member?limit=${PAGE}&offset=${offset}`,
      );
      all.push(...result.items);
      if (all.length >= result.count || result.items.length === 0) break;
      offset += PAGE;
    }

    return all;
  }
}
