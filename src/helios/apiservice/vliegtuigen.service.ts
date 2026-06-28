import { Injectable } from '@nestjs/common';
import { ApiService } from './api.service';
import { VliegtuigRecord } from '../helios.vliegtuigen';

@Injectable()
export class VliegtuigenService {
  constructor(private readonly api: ApiService) {}

  async getVliegtuigen(): Promise<VliegtuigRecord[]> {
    const data = await this.api.get<{ dataset: VliegtuigRecord[] }>('Vliegtuigen/GetObjects', { MAX: '9999' });
    return data.dataset ?? [];
  }

  async saveFlarmcode(id: number, flarmcode: string): Promise<void> {
    await this.api.put('Vliegtuigen/SaveObject', { ID: id, FLARMCODE: flarmcode });
  }
}
