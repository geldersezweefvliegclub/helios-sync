import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { HeliosMqttEvent, MQTT_LEDEN } from '../mqtt/mqtt.events';
import { LidRecord } from '../helios/helios.leden';
import { LoginService } from '../helios/apiservice/login.service';
import { LedenService } from '../helios/apiservice/leden.service';
import { EboekhoudenApiService, EbMemberBody } from './eboekhouden-api.service';
import { ErrorMailService } from '../common/error-mail.service';

interface HeliosLidExtended extends LidRecord {
  ADRES?: string;
  POSTCODE?: string;
  WOONPLAATS?: string;
  TELEFOON?: string;
}

const CRON_EXPRESSION = process.env.CRON_EB_BULKSYNC || '0 3 * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Amsterdam';

@Injectable()
export class EboekhoudenWorker {
  private readonly logger = new Logger(EboekhoudenWorker.name);

  constructor(
    private readonly api: EboekhoudenApiService,
    private readonly config: ConfigService,
    private readonly errorMail: ErrorMailService,
    private readonly loginService: LoginService,
    private readonly ledenService: LedenService,
  ) {
    this.logger.log(`${EboekhoudenWorker.name}: Cron expressie: ${CRON_EXPRESSION} (${CRON_TIMEZONE})`);
  }

  // ---------------------------------------------------------------------------
  // MQTT event: individual lid sync
  // ---------------------------------------------------------------------------

  @OnEvent(MQTT_LEDEN, { async: true })
  async onSyncLid(event: HeliosMqttEvent): Promise<void> {
    const lid = event.resultaat as unknown as HeliosLidExtended | null;
    if (!lid) return;

    if (!lid.LIDNR) {
      this.logger.verbose(`Lid ${lid.ID} (${lid.NAAM}) heeft geen LIDNR, overslaan`);
      return;
    }

    try {
      if (lid.VERWIJDERD) {
        await this.deleteLid(lid);
      } else {
        await this.syncLid(lid);
      }
    } catch (err) {
      this.logger.error(`eBoekhouden sync mislukt voor ${lid.NAAM} (LIDNR=${lid.LIDNR}): ${err}`);
      await this.errorMail.sendSyncError(
        `eBoekhouden sync mislukt voor ${lid.NAAM} (LIDNR=${lid.LIDNR})`,
        err,
      );
    }
  }


  @Cron(CRON_EXPRESSION, { timeZone: CRON_TIMEZONE })
  async runBulkSync(): Promise<void> {
    if (!this.config.get<string>('EB_ACCESS_TOKEN')) {
      this.logger.warn('EB_ACCESS_TOKEN not set, eBoekhouden bulk sync overgeslagen');
      return;
    }
    this.logger.log('Start eBoekhouden bulk sync van alle Helios leden');

    let leden: HeliosLidExtended[];
    try {
      await this.loginService.login();
      const actief = (await this.ledenService.getLeden(false)) as HeliosLidExtended[];
      const verwijderd = (await this.ledenService.getLeden(true)) as HeliosLidExtended[];

      leden = actief.concat(verwijderd);
    } catch (err) {
      this.logger.error(`Ophalen Helios leden mislukt: ${err}`);
      await this.errorMail.sendSyncError('eBoekhouden bulk sync: ophalen Helios leden mislukt', err);
      return;
    }

    const toSync = leden.filter((l) => !!l.LIDNR);
    this.logger.verbose(`${leden.length} leden opgehaald, ${toSync.length} met LIDNR`);

    let ok = 0;
    let failed = 0;

    for (const lid of toSync) {
      try {
        if (lid.VERWIJDERD) {
          await this.deleteLid(lid)
        } else {
          await this.syncLid(lid);
        }

        ok++;
      } catch (err) {
        failed++;
        this.logger.error(`Bulk sync mislukt voor ${lid.NAAM} (LIDNR=${lid.LIDNR}): ${err}`);
        await this.errorMail.sendSyncError(
          `eBoekhouden bulk sync mislukt voor ${lid.NAAM} (LIDNR=${lid.LIDNR})`,
          err,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    this.logger.log(`eBoekhouden bulk sync gereed: ${ok} ok, ${failed} mislukt`);
  }

  // ---------------------------------------------------------------------------
  // Core sync logic
  // ---------------------------------------------------------------------------

  private async syncLid(lid: HeliosLidExtended): Promise<void> {
    const body = this.buildMemberBody(lid);

    const existing = await this.api.findMemberByNumber(lid.LIDNR!);

    if (existing) {
      const current = await this.api.getMember(existing.id);
      if (this.needsUpdate(current, body)) {
        this.logger.log(`Update eBoekhouden lid ${lid.LIDNR} (${lid.NAAM})`);
        await this.api.updateMember(existing.id, body);
      } else {
        this.logger.debug(`Geen wijzigingen voor ${lid.LIDNR} (${lid.NAAM})`);
      }
    } else {
      this.logger.log(`Aanmaken eBoekhouden lid ${lid.LIDNR} (${lid.NAAM})`);
      await this.api.createMember(body);
    }
  }

  private async deleteLid(lid: HeliosLidExtended): Promise<void> {
    const existing = await this.api.findMemberByNumber(lid.LIDNR!);

    if (!existing) {
      this.logger.debug(`Lid ${lid.LIDNR} (${lid.NAAM}) niet gevonden in eBoekhouden, overslaan`);
      return;
    }

    const deletedName = `ZZ ${lid.NAAM} (verwijderd)`;

    if (existing.name === deletedName) {
      this.logger.debug(`Lid ${lid.LIDNR} al gemarkeerd als verwijderd`);
      return;
    }

    this.logger.log(`Markeer eBoekhouden lid ${lid.LIDNR} (${lid.NAAM}) als verwijderd`);
    await this.api.updateMember(existing.id, { name: deletedName });
  }

  private buildMemberBody(lid: HeliosLidExtended): EbMemberBody {
    return {
      memberNumber: lid.LIDNR,
      name: lid.NAAM,
      salutation: lid.VOORNAAM ?? undefined,
      address: lid.ADRES ?? undefined,
      postalCode: lid.POSTCODE ?? undefined,
      city: lid.WOONPLAATS ?? undefined,
      phoneNumber: lid.TELEFOON ?? undefined,
      mobilePhoneNumber: lid.MOBIEL ?? undefined,
      emailAddress: lid.EMAIL ?? undefined,
      freeText1: String(lid.ID),
    };
  }

  private needsUpdate(
    current: import('./eboekhouden-api.service').EbMember,
    body: EbMemberBody,
  ): boolean {
    return (
      current.name !== body.name ||
      (current.salutation ?? '') !== (body.salutation ?? '') ||
      (current.address ?? '') !== (body.address ?? '') ||
      (current.postalCode ?? '') !== (body.postalCode ?? '') ||
      (current.city ?? '') !== (body.city ?? '') ||
      (current.phoneNumber ?? '') !== (body.phoneNumber ?? '') ||
      (current.mobilePhoneNumber ?? '') !== (body.mobilePhoneNumber ?? '') ||
      (current.emailAddress ?? '') !== (body.emailAddress ?? '') ||
      (current.freeText1 ?? '') !== (body.freeText1 ?? '')
    );
  }
}