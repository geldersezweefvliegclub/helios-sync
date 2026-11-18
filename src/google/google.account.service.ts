import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { admin_directory_v1, google } from 'googleapis';
import { randomBytes } from 'node:crypto';
import { GoogleServiceAccount, laadGoogleCredentials, maakGoogleAuthClient } from './google.credentials';

export type GoogleAccount = admin_directory_v1.Schema$User;

export interface GoogleAccountGegevens {
  gebruikersnaam: string;      // deel vóór de @, het domein komt uit GOOGLE_DOMAIN
  voornaam: string;
  achternaam: string;
  herstelEmail?: string;       // privé e-mailadres van het lid
}

/**
 * Interface naar de Google Workspace Admin SDK (Directory API) voor het beheren van accounts.
 *
 * Vereist dat het service account domain-wide delegation heeft voor de scope
 * https://www.googleapis.com/auth/admin.directory.user en
 * https://www.googleapis.com/auth/admin.directory.group, en dat GOOGLE_DIRECTORY_ADMIN
 * (default: GOOGLE_ADMIN_EMAIL) een Workspace beheerder is.
 */
@Injectable()
export class GoogleAccountService {
  private readonly logger = new Logger(GoogleAccountService.name);
  private readonly credentials: GoogleServiceAccount | undefined = laadGoogleCredentials();
  private directory?: admin_directory_v1.Admin;

  constructor(private readonly configService: ConfigService) {}

  /** Account beheer staat alleen aan als GOOGLE_DOMAIN geconfigureerd is */
  isGeconfigureerd(): boolean {
    return !!this.configService.get<string>('GOOGLE_DOMAIN');
  }

  /** Volledig e-mailadres (primaryEmail) voor een gebruikersnaam */
  emailAdres(gebruikersnaam: string): string {
    const domein = this.configService.getOrThrow<string>('GOOGLE_DOMAIN');
    return `${gebruikersnaam.trim().toLowerCase()}@${domein}`;
  }

  /** Haalt een account op, of null als het niet bestaat */
  async getGoogleAccount(gebruikersnaam: string): Promise<GoogleAccount | null> {
    const email = this.emailAdres(gebruikersnaam);
    try {
      const res = await this.getDirectoryApi().users.get({ userKey: email });
      return res.data;
    } catch (err: any) {
      if (err?.code === 404 || err?.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Maakt een nieuw account aan in GOOGLE_ORG_UNIT (default '/'). De API eist een wachtwoord;
   * het account krijgt een willekeurig wachtwoord dat het lid niet gebruikt.
   */
  async maakGoogleAccount(gegevens: GoogleAccountGegevens): Promise<GoogleAccount> {
    const email = this.emailAdres(gegevens.gebruikersnaam);

    const requestBody: admin_directory_v1.Schema$User = {
      primaryEmail: email,
      name: { givenName: gegevens.voornaam, familyName: gegevens.achternaam },
      password: randomBytes(18).toString('base64'),
      changePasswordAtNextLogin: true,
      orgUnitPath: this.configService.get<string>('GOOGLE_ORG_UNIT') || '/',
      recoveryEmail: gegevens.herstelEmail || undefined,
    };

    this.logger.log(`Aanmaken Google account ${email}`);
    const res = await this.getDirectoryApi().users.insert({ requestBody });
    return res.data;
  }

  /**
   * Wijzigt een bestaand account. `gebruikersnaam` is de huidige gebruikersnaam; als
   * `gegevens.gebruikersnaam` afwijkt wordt het account hernoemd (oude adres blijft als alias).
   */
  async wijzigGoogleAccount(gebruikersnaam: string, gegevens: Partial<GoogleAccountGegevens> & { geblokkeerd?: boolean }): Promise<GoogleAccount> {
    const email = this.emailAdres(gebruikersnaam);
    const requestBody: admin_directory_v1.Schema$User = {};

    if (gegevens.gebruikersnaam && this.emailAdres(gegevens.gebruikersnaam) !== email) {
      requestBody.primaryEmail = this.emailAdres(gegevens.gebruikersnaam);
    }
    if (gegevens.voornaam !== undefined || gegevens.achternaam !== undefined) {
      requestBody.name = { givenName: gegevens.voornaam, familyName: gegevens.achternaam };
    }
    if (gegevens.herstelEmail !== undefined) {
      requestBody.recoveryEmail = gegevens.herstelEmail;
    }
    if (gegevens.geblokkeerd !== undefined) {
      requestBody.suspended = gegevens.geblokkeerd;
    }

    this.logger.log(`Wijzigen Google account ${email} — velden: ${Object.keys(requestBody).join(', ')}`);
    const res = await this.getDirectoryApi().users.update({ userKey: email, requestBody });
    return res.data;
  }

  /** Verwijdert het account. Google bewaart het nog 20 dagen; daarna is het definitief weg. */
  async verwijderGoogleAccount(gebruikersnaam: string): Promise<void> {
    const email = this.emailAdres(gebruikersnaam);
    this.logger.log(`Verwijderen Google account ${email}`);
    await this.getDirectoryApi().users.delete({ userKey: email });
  }

  // ---------------------------------------------------------------------------
  // Groepen
  // ---------------------------------------------------------------------------

  /** Volledig e-mailadres van een groep, bv. 'leden' → 'leden@<GOOGLE_DOMAIN>' */
  groepAdres(groep: string): string {
    return groep.includes('@') ? groep.toLowerCase() : this.emailAdres(groep);
  }

  /** E-mailadressen van alle groepen waar het account direct lid van is */
  async getGroepen(gebruikersnaam: string): Promise<string[]> {
    const email = this.emailAdres(gebruikersnaam);
    const groepen: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.getDirectoryApi().groups.list({ userKey: email, pageToken });
      for (const g of res.data.groups ?? []) {
        if (g.email) groepen.push(g.email.toLowerCase());
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return groepen;
  }

  /** Directe leden van een groep (e-mailadres in kleine letters en type: USER, GROUP of CUSTOMER) */
  async getGroepLeden(groep: string): Promise<{ email: string; type: string }[]> {
    const groepEmail = this.groepAdres(groep);
    const leden: { email: string; type: string }[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.getDirectoryApi().members.list({ groupKey: groepEmail, pageToken, maxResults: 200 });
      for (const m of res.data.members ?? []) {
        if (m.email) leden.push({ email: m.email.toLowerCase(), type: m.type ?? 'USER' });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return leden;
  }

  /** Voegt het account toe aan een groep. Is het al lid, dan gebeurt er niets. */
  async voegToeAanGroep(gebruikersnaam: string, groep: string): Promise<void> {
    const email = this.emailAdres(gebruikersnaam);
    const groepEmail = this.groepAdres(groep);
    this.logger.log(`Toevoegen ${email} aan groep ${groepEmail}`);

    // Een net aangemaakt account is niet altijd direct bekend bij de groepen API → enkele pogingen
    for (let poging = 1; ; poging++) {
      try {
        await this.getDirectoryApi().members.insert({
          groupKey: groepEmail,
          requestBody: { email, role: 'MEMBER' },
        });
        return;
      } catch (err: any) {
        const status = err?.code ?? err?.response?.status;
        if (status === 409) {
          this.logger.debug(`${email} is al lid van ${groepEmail}`);
          return;
        }
        if (status === 404 && poging < 4) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * poging));
          continue;
        }
        throw err;
      }
    }
  }

  /** Haalt het account uit een groep. Was het geen lid, dan gebeurt er niets. */
  async verwijderUitGroep(gebruikersnaam: string, groep: string): Promise<void> {
    const email = this.emailAdres(gebruikersnaam);
    const groepEmail = this.groepAdres(groep);
    this.logger.log(`Verwijderen ${email} uit groep ${groepEmail}`);

    try {
      await this.getDirectoryApi().members.delete({ groupKey: groepEmail, memberKey: email });
    } catch (err: any) {
      if ((err?.code ?? err?.response?.status) === 404) {
        this.logger.debug(`${email} was geen lid van ${groepEmail}`);
        return;
      }
      throw err;
    }
  }

  /** Directory API client, lazy aangemaakt zodat de app ook zonder credentials kan starten */
  private getDirectoryApi(): admin_directory_v1.Admin {
    if (!this.directory) {
      const authClient = maakGoogleAuthClient(
        this.credentials,
        [
          'https://www.googleapis.com/auth/admin.directory.user',
          'https://www.googleapis.com/auth/admin.directory.group',
        ],
        this.configService.get<string>('GOOGLE_DIRECTORY_ADMIN') || this.configService.get<string>('GOOGLE_ADMIN_EMAIL'),
      );
      this.directory = google.admin({ version: 'directory_v1', auth: authClient });
    }
    return this.directory;
  }
}
