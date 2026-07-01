import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { SynapseApiService } from './synapse-api.service';
import { SynapseAuthService } from './synapse-auth.service';
import { SynapseRoomsService } from './synapse-rooms.service';
import { SynapseUser } from './synapse.types';
import { ErrorMailService } from '../common/error-mail.service';
import { LidRecord } from '../helios/helios.leden';
import { LoginService } from '../helios/apiservice/login.service';
import { LedenService } from '../helios/apiservice/leden.service';
import { SYNC_LIDTYPES } from './synapse.lidtypes';
import { MQTT_SYNC, SyncMqttEvent } from '../mqtt/mqtt.events';

const CRON_EXPRESSION = process.env.CRON_SYNAPSE_BULKSYNC || '5 3 * * *';
const CRON_TIMEZONE   = process.env.CRON_TIMEZONE || 'Europe/Amsterdam';

// Role flag → rooms config key mapping (matches synapse-rooms.json)
const MAPPING_ROL_NAAR_KAMER: Record<string, string> = {
  LIERIST: 'Lierist',
  LIERIST_IO: 'LIO',
  STARTLEIDER: 'Startleider',
  INSTRUCTEUR: 'Instructeur',
  CIMT: 'CIMT',
  DDWV_CREW: 'DDWV',
  DDWV_BEHEERDER: 'DDWV',
  BEHEERDER: 'Beheerder',
  STARTTOREN: 'Starttoren',
  ROOSTER: 'Rooster',
  SLEEPVLIEGER: 'Sleepvlieger',
  RAPPORTEUR: 'Rapporteur',
  GASTENVLIEGER: 'Gastenvlieger',
  TECHNICUS: 'Technicus',
};

@Injectable()
export class SynapseWorker {
  private readonly logger = new Logger(SynapseWorker.name);

  constructor(
    private readonly api: SynapseApiService,
    private readonly authService: SynapseAuthService,
    private readonly roomsService: SynapseRoomsService,
    private readonly configService: ConfigService,
    private readonly errorMailService: ErrorMailService,
    private readonly loginService: LoginService,
    private readonly ledenService: LedenService,
  ) {
    this.logger.log(`${SynapseWorker.name}: Cron expressie: ${CRON_EXPRESSION} (${CRON_TIMEZONE})`);
  }

  // ---------------------------------------------------------------------------
  // Event handler
  // ---------------------------------------------------------------------------

  @OnEvent(MQTT_SYNC, { async: true })
  async onSyncLid(lid: LidRecord): Promise<void> {
    this.logger.verbose(`Verwerken sync event voor lid ${lid.ID} (${lid.NAAM})`);

    try {
      await this.syncLid(lid);
    } catch (err) {
      this.logger.error(`Sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM}): ${err}`);
      await this.errorMailService.sendSyncError(
        `Sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM})`,
        err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduled bulk sync
  // ---------------------------------------------------------------------------

  @Cron(CRON_EXPRESSION, { timeZone: CRON_TIMEZONE })
  async runBulkSync(): Promise<void> {
    this.logger.log('Start Synapse bulk sync van alle Helios leden');

    let leden: LidRecord[];
    try {
      await this.loginService.login();
      const actief    = await this.ledenService.getLeden(false);
      const verwijderd = await this.ledenService.getLeden(true);
      leden = actief.concat(verwijderd);

      const actiefLidnrs = new Set(actief.map((l) => l.INLOGNAAM).filter(Boolean));     // lijst met inlognamen
      leden = actief.concat(verwijderd.filter((l) => !actiefLidnrs.has(l.INLOGNAAM)));  // verwijderd mag alleen toegevoegd worden als INLOGNAAM niet in actief voorkomt

    } catch (err) {
      this.logger.error(`Ophalen Helios leden mislukt: ${err}`);
      await this.errorMailService.sendSyncError('Synapse bulk sync: ophalen Helios leden mislukt', err);
      return;
    }

    const toSync = leden.filter((l) => !!l.INLOGNAAM);
    this.logger.verbose(`${leden.length} leden opgehaald, ${toSync.length} met INLOGNAAM`);

    let ok = 0;
    let failed = 0;

    for (const lid of toSync) {
      try {
        await this.syncLid(lid);
        ok++;
      } catch (err) {
        failed++;
        this.logger.error(`Bulk sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM}): ${err}`);
        await this.errorMailService.sendSyncError(
          `Synapse bulk sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM})`,
          err,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    this.logger.log(`Synapse bulk sync gereed: ${ok} ok, ${failed} mislukt`);
  }

  // ---------------------------------------------------------------------------
  // Sync logic
  // ---------------------------------------------------------------------------

  private async syncLid(lid: LidRecord): Promise<void> {
    if (!lid.INLOGNAAM) {
      this.logger.verbose(`Lid ${lid.NAAM} (${lid.ID}) heeft geen INLOGNAAM, overslaan`);
      return;
    }

    const existing = await this.getGebruiker(lid.INLOGNAAM.toLowerCase());

    if (lid.VERWIJDERD) {
      if (existing?.deactivated) {
        this.logger.debug(`Lid ${lid.NAAM} is al gedeactiveerd in Synapse, overslaan`);
        return;
      }
      this.logger.log(`Lid ${lid.NAAM} is VERWIJDERD, deactivatie in Synapse`);
      await this.verwijderGebruiker(lid, existing);
      return;
    }

    if (SYNC_LIDTYPES.includes(lid.LIDTYPE_ID)) {
      const password = lid.INGEVOERD_WACHTWOORD ?? null;
      this.logger.verbose(`Sync lid ${lid.NAAM} (LIDTYPE_ID=${lid.LIDTYPE_ID}) password=${password ? 'yes' : 'no'}`);

      await this.updateGebruiker(lid, password, existing);
      await this.toevoegenAanKamers(lid);

      if (password) {
        await this.markeerAlsFavoriet(lid, password);
      }
    } else {
      if (existing?.deactivated) {
        this.logger.debug(`Lid ${lid.NAAM} heeft LIDTYPE_ID=${lid.LIDTYPE_ID} maar is al gedeactiveerd in Synapse, overslaan`);
        return;
      }
      this.logger.log(`Lid ${lid.NAAM} heeft LIDTYPE_ID=${lid.LIDTYPE_ID}, deactivatie in Synapse`);
      await this.verwijderGebruiker(lid, existing);
    }
  }

  // ---------------------------------------------------------------------------
  // Synapse operations
  // ---------------------------------------------------------------------------

  private async updateGebruiker(lid: LidRecord, password: string | null, existing: SynapseUser | null = null): Promise<void> {
    const domain = this.configService.getOrThrow<string>('SYNAPSE_DOMAIN');
    const username = lid.INLOGNAAM.toLowerCase();
    const matrixId = `@${username}:${domain}`;
    const path = `_synapse/admin/v2/users/${encodeURIComponent(matrixId)}`;

    if (existing === null) {
      existing = await this.getGebruiker(username);
    }
    const gebruikerBestaat = existing !== null;

    let updateNeeded = false;
    let avatarUrl: string | null = null;

    if (!gebruikerBestaat) {
      avatarUrl = lid.AVATAR ? await this.uploadAvatar(lid) : null;
      updateNeeded = true;
    } else {
      const currentEmail = existing!.threepids?.find((t) => t.medium === 'email')?.address ?? null;
      if (currentEmail !== (lid.EMAIL ?? null)) {
        this.logger.debug(`Email aangepast: ${currentEmail} → ${lid.EMAIL}`);
        updateNeeded = true;
      } else if (existing!.admin !== lid.BEHEERDER) {
        this.logger.debug(`Is nu beheerder geworden: ${existing!.admin} → ${lid.BEHEERDER}`);
        updateNeeded = true;
      } else if (existing!.displayname !== lid.NAAM) {
        this.logger.debug(`Naam aangepast: ${existing!.displayname} → ${lid.NAAM}`);
        updateNeeded = true;
      } else if (existing!.deactivated !== lid.VERWIJDERD) {
        this.logger.debug(`Lid is hersteld`);
        updateNeeded = true;
      }
    }

    this.logger.debug(`updateGebruiker: ${matrixId} — bestaat=${gebruikerBestaat}, updateNeeded=${updateNeeded}, password=${password ? 'yes' : 'no'}`);
    if (!gebruikerBestaat || updateNeeded || password) {
      this.logger.log(`updateGebruiker: ${matrixId}`);
      const data: Record<string, unknown> = {};

      if (!gebruikerBestaat || updateNeeded) {
        data.displayname = lid.NAAM;
        data.admin = lid.BEHEERDER;
        data.deactivated = false;
        data.user_type = null;
        data.locked = false;
        data.threepids = lid.EMAIL
          ? [{ medium: 'email', address: lid.EMAIL }]
          : [];
      }

      if (password) {
        data.password = password;
        data.logout_devices = false;
      }

      if (avatarUrl) {
        data.avatar_url = avatarUrl;
      }

      if (!gebruikerBestaat && !password) {
        data.password = randomBytes(10).toString('base64');
        this.logger.debug(`Genereer tijdelijk wachtwoord voor aanmaken ${matrixId}`);
      }
      // Re-activeren vereist een wachtwoord; genereer een tijdelijk wachtwoord indien nodig
      if (!lid.VERWIJDERD && gebruikerBestaat && existing!.deactivated && !data.password) {
        data.password = randomBytes(10).toString('base64');
        this.logger.debug(`Genereer tijdelijk wachtwoord voor heractivatie ${matrixId}`);
      }

      if (Object.keys(data).length === 0) {
        this.logger.warn(`Geen data voor ${matrixId}`);
        return;
      }

      this.logger.debug(`PUT ${path} — keys: ${Object.keys(data).join(', ')}`);
      await this.api.put<SynapseUser>(path, data);
      this.logger.verbose(`update gebruiker gereed: ${matrixId}`);
    } else {
      this.logger.verbose(`Geen update nodig voor ${matrixId}`);
    }
  }

  private async verwijderGebruiker(lid: LidRecord, existing: SynapseUser | null = null): Promise<void> {
    const domain = this.configService.getOrThrow<string>('SYNAPSE_DOMAIN');
    const username = lid.INLOGNAAM.toLowerCase();
    const matrixId = `@${username}:${domain}`;

    if (existing === null) {
      existing = await this.getGebruiker(username);
    }

    if (!existing) {
      this.logger.debug(`User ${matrixId} besaat niet in Synapse, er is niets te verwijderen`);
      return;
    }

    if (existing.deactivated) {
      this.logger.debug(`User ${matrixId} is al gedeactiveerd, er is niets te doen`);
      return;
    }

    this.logger.log(`verwijder gebruiker: ${matrixId}`);

    await this.api.post(`_synapse/admin/v1/deactivate/${encodeURIComponent(matrixId)}`, { erase: true });
    this.logger.log(`verwijderGebruiker gereed: ${matrixId}`);
  }

  private async toevoegenAanKamers(lid: LidRecord): Promise<void> {
    const domain = this.configService.getOrThrow<string>('SYNAPSE_DOMAIN');
    const matrixUserId = `@${lid.INLOGNAAM.toLowerCase()}:${domain}`;

    let roomsConfig: ReturnType<SynapseRoomsService['loadRoomsConfig']>;
    try {
      roomsConfig = this.roomsService.loadRoomsConfig();
    } catch (err) {
      this.logger.warn(`Kan kamers config niet laden, sla kamer toewijzing over: ${err}`);
      return;
    }

    await this.roomsService.ensureRoomMapping();
    this.logger.verbose(`toevoegenAanKamers: ${matrixUserId}`);

    // Toevoegen aan algemene kamers
    await this.roomsService.addUserToRooms(roomsConfig.kamers['algemeen'] ?? [], matrixUserId);

    // Toevoegen aan rol-specifieke kamers
    for (const [roleFlag, configKey] of Object.entries(MAPPING_ROL_NAAR_KAMER)) {
      if ((lid as any)[roleFlag] === true) {
        const rooms = roomsConfig.kamers[configKey] ?? [];
        if (rooms.length > 0) {
          this.logger.debug(`Toevoegen ${matrixUserId} aan ${configKey} kamer (${roleFlag}=true)`);
          await this.roomsService.addUserToRooms(rooms, matrixUserId);
        }
      }
    }
  }

  private async markeerAlsFavoriet(lid: LidRecord, password: string): Promise<void> {
    const domain = this.configService.getOrThrow<string>('SYNAPSE_DOMAIN');
    const username = lid.INLOGNAAM.toLowerCase();
    const matrixUserId = `@${username}:${domain}`;

    let roomsConfig: ReturnType<SynapseRoomsService['loadRoomsConfig']>;
    try {
      roomsConfig = this.roomsService.loadRoomsConfig();
    } catch (err) {
      this.logger.warn(`Kan kamers config niet laden, sla favorieten over: ${err}`);
      return;
    }

    if (!roomsConfig.favorieten?.length) {
      this.logger.debug('Geen favorieten geconfigureerd');
      return;
    }

    await this.roomsService.ensureRoomMapping();
    this.logger.verbose(`markeer als favoriet: ${matrixUserId}`);

    const userToken = await this.authService.getUserToken(username, password);
    await this.roomsService.markRoomsAsFavorite(roomsConfig.favorieten, matrixUserId, userToken);
  }

  private async getGebruiker(username: string): Promise<SynapseUser | null> {
    const domain = this.configService.getOrThrow<string>('SYNAPSE_DOMAIN');
    const matrixId = `@${username.toLowerCase()}:${domain}`;
    const path = `_synapse/admin/v2/users/${encodeURIComponent(matrixId)}`;

    try {
      return (await this.api.get<SynapseUser>(path)) ?? null;
    } catch (err: any) {
      if (err?.message?.includes('404') || err?.message?.includes('M_NOT_FOUND')) {
        return null;
      }
      throw err;
    }
  }

  private async uploadAvatar(lid: LidRecord): Promise<string | null> {
    if (!lid.AVATAR) return null;

    this.logger.debug(`Uploading avatar van ${lid.AVATAR}`);

    let avatarResponse: Response;
    try {
      avatarResponse = await fetch(lid.AVATAR);
    } catch (err) {
      this.logger.warn(`Laden avatar mislukt: ${err}`);
      return null;
    }

    if (!avatarResponse.ok) {
      this.logger.warn(`Laden avatar fout: ${avatarResponse.status}`);
      return null;
    }

    const contentType = avatarResponse.headers.get('content-type') ?? 'image/jpeg';
    const buffer = Buffer.from(await avatarResponse.arrayBuffer());

    const path = `_matrix/media/v3/upload?filename=${encodeURIComponent(String(lid.ID))}`;
    try {
      const result = await this.api.postBinary<{ content_uri: string }>(path, buffer, contentType);
      this.logger.debug(`Avatar uploaded: ${result.content_uri}`);
      return result.content_uri;
    } catch (err) {
      this.logger.warn(`Avatar upload mislukt: ${err}`);
      return null;
    }
  }
}
