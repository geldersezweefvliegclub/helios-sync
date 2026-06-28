import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoginService } from '../helios/apiservice/login.service';
import { VliegtuigenService } from '../helios/apiservice/vliegtuigen.service';
import { ErrorMailService } from '../common/error-mail.service';

const CRON_EXPRESSION = process.env.CRON_GLIDERNET_BULKSYNC || '30 4 * * *';
const CRON_TIMEZONE   = process.env.CRON_TIMEZONE || 'Europe/Amsterdam';

const GLIDERNET_URL = 'http://ddb.glidernet.org/download';

@Injectable()
export class GlidernetWorker {
  private readonly logger = new Logger(GlidernetWorker.name);

  constructor(
    private readonly loginService: LoginService,
    private readonly vliegtuigenService: VliegtuigenService,
    private readonly errorMailService: ErrorMailService,
  ) {
    this.logger.log(`${GlidernetWorker.name}: Cron expressie: ${CRON_EXPRESSION} (${CRON_TIMEZONE})`);
  }

  @Cron(CRON_EXPRESSION, { timeZone: CRON_TIMEZONE })
  async runImport(): Promise<void> {
    this.logger.log('Start GliderNet FLARM import');

    let flarmMap: Map<string, string>;
    try {
      flarmMap = await this.fetchFlarmMap();
      this.logger.verbose(`${flarmMap.size} FLARM registraties opgehaald van GliderNet`);
    } catch (err) {
      this.logger.error(`Ophalen GliderNet data mislukt: ${err}`);
      await this.errorMailService.sendSyncError('GliderNet FLARM import: ophalen GliderNet data mislukt', err);
      return;
    }

    let vliegtuigen: Awaited<ReturnType<VliegtuigenService['getVliegtuigen']>>;
    try {
      await this.loginService.login();
      vliegtuigen = await this.vliegtuigenService.getVliegtuigen();
      this.logger.verbose(`${vliegtuigen.length} vliegtuigen opgehaald uit Helios`);
    } catch (err) {
      this.logger.error(`Ophalen Helios vliegtuigen mislukt: ${err}`);
      await this.errorMailService.sendSyncError('GliderNet FLARM import: ophalen Helios vliegtuigen mislukt', err);
      return;
    }

    let updated = 0;
    let skipped = 0;

    for (const vliegtuig of vliegtuigen) {
      if (!vliegtuig.REGISTRATIE) {
        continue;
      }

      const newFlarmcode = flarmMap.get(vliegtuig.REGISTRATIE);
      if (!newFlarmcode) {
        continue;
      }

      if (vliegtuig.FLARMCODE === newFlarmcode) {
        skipped++;
        continue;
      }

      try {
        this.logger.log(`Update FLARMCODE voor ${vliegtuig.REGISTRATIE}: ${vliegtuig.FLARMCODE ?? '(leeg)'} → ${newFlarmcode}`);
        await this.vliegtuigenService.saveFlarmcode(vliegtuig.ID, newFlarmcode);
        updated++;
      } catch (err) {
        this.logger.error(`Opslaan FLARMCODE mislukt voor ${vliegtuig.REGISTRATIE}: ${err}`);
        await this.errorMailService.sendSyncError(
          `GliderNet FLARM import: opslaan mislukt voor ${vliegtuig.REGISTRATIE}`,
          err,
        );
      }
    }

    this.logger.log(`GliderNet FLARM import gereed: ${updated} bijgewerkt, ${skipped} ongewijzigd`);
  }

  private async fetchFlarmMap(): Promise<Map<string, string>> {
    const response = await fetch(GLIDERNET_URL);
    if (!response.ok) {
      throw new Error(`GliderNet download mislukt: HTTP ${response.status}`);
    }

    const text = await response.text();
    const lines = text.split(/\r?\n/);

    const rawHeader = lines.shift() ?? '';
    const header = this.parseCsvLine(rawHeader).map((h) => h.replace(/'/g, ''));

    const flarmMap = new Map<string, string>();

    for (const line of lines) {
      if (!line.trim()) continue;

      const velden = this.parseCsvLine(line).map((v) => v.replace(/'/g, ''));
      if (velden.length !== header.length) continue;

      const record: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        record[header[i]] = velden[i];
      }

      const registration = record['REGISTRATION'];
      const deviceId = record['DEVICE_ID'];

      if (!registration) continue;

      const existing = flarmMap.get(registration);
      if (!existing) {
        flarmMap.set(registration, deviceId);
      } else if (!existing.split(',').includes(deviceId)) {
        flarmMap.set(registration, `${existing},${deviceId}`);
      }
    }

    return flarmMap;
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }
}
