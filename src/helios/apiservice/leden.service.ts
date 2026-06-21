import { Injectable } from '@nestjs/common';
import { ApiService } from './api.service';
import { LidRecord } from '../helios.leden';

@Injectable()
export class LedenService {
  constructor(private readonly api: ApiService) {}

  async getLeden(): Promise<LidRecord[]> {
    const data = await this.api.get<{ dataset: LidRecord[] }>('Leden', { max: '9999' });
    return data.dataset ?? [];
  }
}