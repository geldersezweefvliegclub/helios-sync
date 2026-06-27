import { Injectable } from '@nestjs/common';
import { ApiService } from './api.service';
import { LidRecord } from '../helios.leden';

@Injectable()
export class LedenService {
  constructor(private readonly api: ApiService) {}

  async getLeden(verwijderd: boolean = false): Promise<LidRecord[]> {
    const data = await this.api.get<{ dataset: LidRecord[] }>('Leden/GetObjects', { MAX: '9999', VERWIJDERD: verwijderd ? "true" : "false" });
    return data.dataset ?? [];
  }
}