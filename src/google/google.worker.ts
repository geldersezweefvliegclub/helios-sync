import {Injectable, Logger} from '@nestjs/common';
import {OnEvent} from '@nestjs/event-emitter';
import {Cron} from '@nestjs/schedule';
import {HeliosMqttEvent, MQTT_LEDEN} from '../mqtt/mqtt.events';
import {LidRecord} from '../helios/helios.leden';
import {ErrorMailService} from '../common/error-mail.service';
import {GoogleAccount, GoogleAccountGegevens, GoogleAccountService} from './google.account.service';
import {GOOGLE_BEHEERDE_GROEPEN, GOOGLE_LIDTYPE_GROEP} from './google.lidtypes';
import {HeliosLidTypes} from '../helios/helios.types';
import {TOEVOEGEN, AANPASSEN, VERWIJDERD, HERSTEL, ELIMINEER} from '../mqtt/mqtt.types';
import {LoginService} from '../helios/apiservice/login.service';
import {LedenService} from '../helios/apiservice/leden.service';

// Draait standaard tegelijk met de Synapse bulk sync; Google vervangt Synapse
const CRON_EXPRESSION = process.env.CRON_GOOGLE_BULKSYNC || '5 3 * * *';
const CRON_TIMEZONE   = process.env.CRON_TIMEZONE || 'Europe/Amsterdam';

// Vangnet: vindt de opruimronde meer weesaccounts dan dit, dan wordt er niets verwijderd en volgt een mail.
// Beschermt tegen een lege of onvolledige ledenlijst uit Helios die anders alle accounts zou wissen.
const MAX_WEES_ACCOUNTS = Number(process.env.GOOGLE_MAX_WEES_ACCOUNTS ?? 10);

/**
 * Houdt Google Workspace accounts in sync met de ledenadministratie in Helios.
 *
 * Luistert naar MQTT events op de leden tabel en zorgt per lid dat:
 *  - leden met recht op een account, ook echt een account hebben,
 *  - naam en herstel e-mailadres overeenkomen met Helios,
 *  - het account in de juiste beheerde groep zit (lid / donateur),
 *  - het account verwijderd wordt zodra het lid zijn lidmaatschap heeft beëindigd.
 *
 * De gebruikersnaam van het Google account komt uit het GMAIL veld van het lid.
 */
@Injectable()
export class GoogleWorker
{
   private readonly logger = new Logger(GoogleWorker.name);

   /**
    * Wachtrij per lid: lid.ID → Promise van de laatst ingeplande sync voor dat lid.
    *
    * Waarom: MQTT events komen asynchroon binnen en NestJS roept de handler voor elk event direct
    * aan, ook als de vorige nog bezig is. Als een lid twee keer snel achter elkaar wordt opgeslagen,
    * zouden twee syncs tegelijk lopen. Beide zien dan "geen account" en proberen het allebei aan
    * te maken, of een hernoeming en een groepswijziging lopen door elkaar heen.
    *
    * Hoe: in plaats van een echte queue gebruiken we een keten van Promises. Elk nieuw event
    * hangt zich met `.then()` achter de Promise die in de Map staat, en zet daarna zijn eigen
    * Promise in de Map. Zo start een sync pas als de vorige voor hetzelfde lid klaar is.
    *
    * Voorbeeld, drie events voor lid 42 vlak na elkaar:
    *
    *    event A:  Map leeg              → A start direct          Map = {42: A}
    *    event B:  Map heeft A           → B = A.then(sync B)      Map = {42: B}
    *    event C:  Map heeft B           → C = B.then(sync C)      Map = {42: C}
    *
    *    A klaar → B start → B klaar → C start → C klaar
    *
    * Als A klaar is staat er B in de Map (niet A), dus A ruimt niets op. Alleen C, de laatste
    * in de keten, ziet zichzelf nog in de Map staan en verwijdert de entry. De Map blijft dus
    * klein: er staan alleen leden in waarvoor op dit moment een sync loopt of wacht.
    *
    * Events voor verschillende leden hebben elk hun eigen keten en lopen gewoon parallel.
    */
   private readonly wachtrijPerLid = new Map<number, Promise<void>>();

   constructor(
      private readonly accountService: GoogleAccountService,
      private readonly errorMailService: ErrorMailService,
      private readonly loginService: LoginService,
      private readonly ledenService: LedenService,
   )
   {
      this.logger.log(`${GoogleWorker.name}: Cron expressie: ${CRON_EXPRESSION} (${CRON_TIMEZONE})`);
   }

   // ---------------------------------------------------------------------------
   // Event handler
   // ---------------------------------------------------------------------------

   /**
    * Wordt aangeroepen bij elk toevoegen / wijzigen / verwijderen van een lid in Helios.
    * Events voor hetzelfde lid worden geserialiseerd zodat twee syncs elkaar niet in de weg
    * zitten (bv. twee keer een account aanmaken). Events voor verschillende leden lopen parallel.
    */
   @OnEvent(MQTT_LEDEN, {async: true})
   async onLidGewijzigd(event: HeliosMqttEvent): Promise<void>
   {
      if (!this.accountService.isGeconfigureerd())
      {
         this.logger.verbose('GOOGLE_DOMAIN is niet geconfigureerd, overslaan');
         return;
      }

      // Het event bevat de nieuwe toestand van het lid (resultaat) en de oude toestand (voor).
      // Bij verwijderen is er geen resultaat; dan gebruiken we de oude toestand om te bepalen
      // welk account weg moet. 'voor' is nodig om een gewijzigde gebruikersnaam (GMAIL) te herkennen.
      const lid = (event.resultaat ?? event.voor) as unknown as LidRecord | null;
      const voor = event.voor as unknown as LidRecord | null;
      if (!lid) return;

      // Inplannen in de wachtrij van dit lid (zie uitleg bij wachtrijPerLid).
      // - Loopt er niets voor dit lid, dan is 'vorige' een al afgeronde Promise en start de sync direct.
      // - Loopt er wel iets, dan start deze sync pas als die klaar is.
      // verwerkEvent vangt zelf alle fouten af en geeft dus nooit een rejected Promise terug.
      // Dat is belangrijk: een rejected Promise zou de .then() van alle volgende events overslaan.
      await this.inWachtrij(lid.ID, () => this.verwerkEvent(event.type, lid, voor));
   }

   /**
    * Zet een taak in de wachtrij van een lid (zie uitleg bij wachtrijPerLid) en wacht tot hij klaar is.
    * De taak mag nooit een rejected Promise teruggeven, anders worden volgende taken overgeslagen.
    */
   private async inWachtrij(lidId: number, taak: () => Promise<void>): Promise<void>
   {
      const vorige = this.wachtrijPerLid.get(lidId) ?? Promise.resolve();
      const huidige = vorige.then(taak);
      this.wachtrijPerLid.set(lidId, huidige);

      try
      {
         // Wachten tot deze sync klaar is (en dus ook alle eerdere voor dit lid)
         await huidige;
      }
      finally
      {
         // Opruimen, maar alleen als wij nog de laatste in de keten zijn. Is er intussen een
         // nieuwer event achter ons gehangen, dan staat dat in de Map en ruimt dat later zelf op.
         if (this.wachtrijPerLid.get(lidId) === huidige)
         {
            this.wachtrijPerLid.delete(lidId);
         }
      }
   }

   // ---------------------------------------------------------------------------
   // Scheduled bulk check
   // ---------------------------------------------------------------------------

   /**
    * Controleert periodiek alle leden in Helios en brengt hun Google account in de gewenste
    * toestand. Vangt gemiste MQTT events op (bv. tijdens een herstart of storing).
    */
   @Cron(CRON_EXPRESSION, {timeZone: CRON_TIMEZONE})
   async runBulkSync(): Promise<void>
   {
      if (!this.accountService.isGeconfigureerd())
      {
         this.logger.verbose('GOOGLE_DOMAIN is niet geconfigureerd, bulk sync overslaan');
         return;
      }

      this.logger.log('Start Google bulk sync van alle Helios leden');

      let leden: LidRecord[];
      let actief: LidRecord[];
      try
      {
         await this.loginService.login();
         actief = await this.ledenService.getLeden(false);
         const verwijderd = await this.ledenService.getLeden(true);

         // Een verwijderd lid mag alleen meedoen als zijn gebruikersnaam niet (meer) door een actief
         // lid gebruikt wordt, anders zou het account van het actieve lid verwijderd worden
         const actieveNamen = new Set(actief.map((l) => this.gebruikersnaam(l)).filter(Boolean));
         leden = actief.concat(verwijderd.filter((l) => !actieveNamen.has(this.gebruikersnaam(l))));
      }
      catch (err)
      {
         this.logger.error(`Ophalen Helios leden mislukt: ${err}`);
         await this.errorMailService.sendSyncError('Google bulk sync: ophalen Helios leden mislukt', err);
         return;
      }

      const teSyncen = leden.filter((l) => !!this.gebruikersnaam(l));
      this.logger.verbose(`${leden.length} leden opgehaald, ${teSyncen.length} met Google gebruikersnaam`);

      let ok = 0;
      let mislukt = 0;

      for (const lid of teSyncen)
      {
         // Via de wachtrij van het lid, zodat de bulk sync niet botst met een gelijktijdig MQTT event
         await this.inWachtrij(lid.ID, async () =>
         {
            try
            {
               await this.syncLid(AANPASSEN, lid, null);
               ok++;
            }
            catch (err)
            {
               mislukt++;
               this.logger.error(`Google bulk sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM}): ${err}`);
               await this.errorMailService.sendSyncError(`Google bulk sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM})`, err);
            }
         });
         // Rustig aan richting de Directory API (quota per minuut)
         await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.logger.log(`Google bulk sync gereed: ${ok} ok, ${mislukt} mislukt`);

      // Alleen opruimen als alle leden goed gesynchroniseerd zijn; anders is het beeld mogelijk onvolledig
      if (mislukt > 0)
      {
         this.logger.warn('Opruimen weesaccounts overgeslagen omdat de bulk sync fouten had');
         return;
      }

      try
      {
         // zorg dat accounts die bij geen enkel actief lid horen verwijderd worden (bv. lid definitief verwijderd terwijl helios-sync niet draaide)
         await this.ruimWeesAccountsOp(actief);
      }
      catch (err)
      {
         this.logger.error(`Opruimen weesaccounts mislukt: ${err}`);
         await this.errorMailService.sendSyncError('Google bulk sync: opruimen weesaccounts mislukt', err);
      }
   }

   /**
    * Verwijdert accounts die in een beheerde groep (leden / donateurs) zitten, maar bij geen enkel
    * actief Helios lid met recht op een account horen. Bijvoorbeeld een lid dat in Helios definitief
    * verwijderd is terwijl helios-sync niet draaide, of een GMAIL die gewijzigd werd zonder MQTT event.
    *
    * Veiligheid:
    *  - alleen gebruikers uit GOOGLE_DOMAIN, geen geneste groepen of externe adressen,
    *  - Workspace beheerders worden nooit verwijderd,
    *  - bij een lege ledenlijst of meer dan MAX_WEES_ACCOUNTS wezen wordt niets verwijderd.
    */
   private async ruimWeesAccountsOp(actief: LidRecord[]): Promise<void>
   {
      if (actief.length === 0)
      {
         this.logger.warn('Geen actieve leden uit Helios ontvangen, opruimen weesaccounts overgeslagen');
         return;
      }

      // Adressen van alle accounts die er volgens Helios horen te zijn
      const gewenst = new Set<string>();
      for (const lid of actief)
      {
         const naam = this.gebruikersnaam(lid);
         if (naam && !lid.VERWIJDERD && GOOGLE_LIDTYPE_GROEP[lid.LIDTYPE_ID as HeliosLidTypes])
         {
            gewenst.add(this.accountService.emailAdres(naam));
         }
      }

      // Alle gebruikers in de beheerde groepen verzamelen
      const domein = '@' + this.accountService.emailAdres('x').split('@')[1];
      const inGroepen = new Set<string>();
      for (const groep of GOOGLE_BEHEERDE_GROEPEN)
      {
         for (const lidmaatschap of await this.accountService.getGroepLeden(groep))
         {
            if (lidmaatschap.type === 'USER' && lidmaatschap.email.endsWith(domein))
            {
               inGroepen.add(lidmaatschap.email);
            }
         }
      }

      const wezen = [...inGroepen].filter((email) => !gewenst.has(email));
      this.logger.log(`Weesaccounts: ${wezen.length} gevonden (${inGroepen.size} in beheerde groepen, ${gewenst.size} verwacht)`);

      if (wezen.length === 0) return;

      if (wezen.length > MAX_WEES_ACCOUNTS)
      {
         const melding = `${wezen.length} weesaccounts gevonden, meer dan het maximum van ${MAX_WEES_ACCOUNTS}. ` +
            `Er is niets verwijderd. Controleer handmatig:\n${wezen.join('\n')}`;
         this.logger.warn(melding);
         await this.errorMailService.sendSyncError('Google bulk sync: te veel weesaccounts, niets verwijderd', melding);
         return;
      }

      for (const email of wezen)
      {
         const gebruikersnaam = email.split('@')[0];
         try
         {
            const account = await this.accountService.getGoogleAccount(gebruikersnaam);
            if (!account) continue;
            if (account.isAdmin || account.isDelegatedAdmin)
            {
               this.logger.warn(`Weesaccount ${email} is Workspace beheerder, niet verwijderd`);
               continue;
            }
            this.logger.log(`Weesaccount ${email} hoort bij geen actief lid met recht op een account`);
            await this.accountService.verwijderGoogleAccount(gebruikersnaam);
         }
         catch (err)
         {
            this.logger.error(`Verwijderen weesaccount ${email} mislukt: ${err}`);
            await this.errorMailService.sendSyncError(`Google bulk sync: verwijderen weesaccount ${email} mislukt`, err);
         }
      }
   }

   /** Genormaliseerde Google gebruikersnaam van een lid, of null */
   private gebruikersnaam(lid: LidRecord | null): string | null
   {
      return lid?.GMAIL?.trim().toLowerCase() || null;
   }

   /**
    * Voert de sync uit voor één event. Fouten worden gelogd en per mail gemeld, maar niet
    * doorgegooid: een mislukte sync mag de verwerking van volgende events niet blokkeren.
    */
   private async verwerkEvent(type: HeliosMqttEvent['type'], lid: LidRecord, voor: LidRecord | null): Promise<void>
   {
      try
      {
         await this.syncLid(type, lid, voor);
      }
      catch (err)
      {
         this.logger.error(`Google sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM}): ${err}`);
         await this.errorMailService.sendSyncError(`Google sync mislukt voor ${lid.NAAM} (${lid.INLOGNAAM})`, err);
      }
   }

   // ---------------------------------------------------------------------------
   // Sync logic
   // ---------------------------------------------------------------------------

   /**
    * Brengt het Google account van één lid in de gewenste toestand:
    * aanmaken, bijwerken (incl. hernoemen en deblokkeren), of verwijderen.
    *
    * @param type  soort MQTT event (toevoegen / aanpassen / verwijderen)
    * @param lid   nieuwe toestand van het lid (bij verwijderen de laatst bekende toestand)
    * @param voor  oude toestand van het lid, null bij een nieuw lid
    */
   private async syncLid(type: HeliosMqttEvent['type'], lid: LidRecord, voor: LidRecord | null): Promise<void>
   {
      // Gebruikersnamen genormaliseerd, zodat hoofdletters / spaties geen valse wijziging opleveren
      const oudeNaam = this.gebruikersnaam(voor);
      const nieuweNaam = this.gebruikersnaam(lid);

      if (!nieuweNaam && !oudeNaam)
      {
         this.logger.verbose(`Lid ${lid.NAAM} (${lid.ID}) heeft geen Google account informatie, overslaan`);
         return;
      }

      // Een lid heeft recht op een account als het niet verwijderd is, een gebruikersnaam heeft
      // en een lidtype dat aan een groep gekoppeld is
      const groep = GOOGLE_LIDTYPE_GROEP[lid.LIDTYPE_ID as HeliosLidTypes];
      const verwijderEvent = type === VERWIJDERD || type === ELIMINEER;
      const heeftRechtOpGoogleAccount = !verwijderEvent && !lid.VERWIJDERD && !!nieuweNaam && !!groep;

      // Zoek het bestaande account. Bij een gewijzigde GMAIL staat het account nog onder de oude naam;
      // 'gebruikersnaam' is de naam waaronder het account nu in Google bekend is.
      let gebruikersnaam = nieuweNaam ?? oudeNaam!;
      let account = nieuweNaam ? await this.accountService.getGoogleAccount(nieuweNaam) : null;
      if (!account && oudeNaam && oudeNaam !== nieuweNaam)
      {
         account = await this.accountService.getGoogleAccount(oudeNaam);
         if (account) gebruikersnaam = oudeNaam;
      }

      // Geen recht (meer) op een account → verwijderen als het er is
      if (!heeftRechtOpGoogleAccount)

      {
         if (!account)
         {
            this.logger.debug(`Lid ${lid.NAAM} heeft geen recht op een Google account en heeft er geen, overslaan`);
            return;
         }
         this.logger.log(`Lid ${lid.NAAM} (LIDTYPE_ID=${lid.LIDTYPE_ID}, VERWIJDERD=${lid.VERWIJDERD}) heeft geen recht meer op Google account`);
         await this.accountService.verwijderGoogleAccount(gebruikersnaam);
         return;
      }

      // Wel recht → account aanmaken, of alleen de afwijkende velden bijwerken
      const gewenst = this.bouwGegevens(lid, nieuweNaam!);

      if (!account)
      {
         await this.accountService.maakGoogleAccount(gewenst);
      }
      else
      {
         const wijzigingen = this.bepaalWijzigingen(account, gewenst);
         if (Object.keys(wijzigingen).length === 0)
         {
            this.logger.verbose(`Geen wijzigingen voor Google account ${account.primaryEmail}`);
         }
         else
         {
            await this.accountService.wijzigGoogleAccount(gebruikersnaam, wijzigingen);
         }
      }

      // Na een eventuele hernoeming staat het account onder de nieuwe naam.
      // Bij een nieuw account hoeven de huidige groepen niet opgevraagd te worden.
      await this.syncGroepen(nieuweNaam!, groep!, !account);
   }

   /**
    * Zorgt dat het account in precies één van de beheerde groepen (lid / donateur) zit.
    * Groepen die niet door helios-sync beheerd worden blijven ongemoeid.
    */
   private async syncGroepen(gebruikersnaam: string, groep: string, nieuwAccount: boolean): Promise<void>
   {
      const gewenst = this.accountService.groepAdres(groep);
      const beheerd = GOOGLE_BEHEERDE_GROEPEN.map((g) => this.accountService.groepAdres(g));
      const huidig = nieuwAccount ? [] : await this.accountService.getGroepen(gebruikersnaam);

      // Eerst toevoegen aan de juiste groep, daarna uit de andere beheerde groepen halen,
      // zodat het account nooit (tijdelijk) in geen enkele groep zit
      if (!huidig.includes(gewenst))
      {
         await this.accountService.voegToeAanGroep(gebruikersnaam, gewenst);
      }

      for (const g of huidig)
      {
         if (beheerd.includes(g) && g !== gewenst)
         {
            await this.accountService.verwijderUitGroep(gebruikersnaam, g);
         }
      }
   }

   /** Vertaalt een Helios lid naar de gewenste gegevens van het Google account */
   private bouwGegevens(lid: LidRecord, gebruikersnaam: string): GoogleAccountGegevens
   {
      const achternaam = [lid.TUSSENVOEGSEL, lid.ACHTERNAAM].filter((s) => s?.trim()).join(' ').trim();

      return {
         gebruikersnaam,
         voornaam: lid.VOORNAAM?.trim() || lid.NAAM,
         achternaam: achternaam || lid.NAAM,     // Google vereist een niet-lege achternaam
         herstelEmail: lid.EMAIL?.trim() || undefined,
      };
   }

   /**
    * Vergelijkt het bestaande Google account met de gewenste gegevens en geeft alleen de
    * velden terug die afwijken. Een leeg object betekent: niets te doen.
    */
   private bepaalWijzigingen(
      account: GoogleAccount,
      gewenst: GoogleAccountGegevens,
   ): Partial<GoogleAccountGegevens> & { geblokkeerd?: boolean }
   {
      const wijzigingen: Partial<GoogleAccountGegevens> & { geblokkeerd?: boolean } = {};

      if (account.primaryEmail?.toLowerCase() !== this.accountService.emailAdres(gewenst.gebruikersnaam))
      {
         wijzigingen.gebruikersnaam = gewenst.gebruikersnaam;
      }
      if (account.name?.givenName !== gewenst.voornaam || account.name?.familyName !== gewenst.achternaam)
      {
         wijzigingen.voornaam = gewenst.voornaam;
         wijzigingen.achternaam = gewenst.achternaam;
      }
      if ((account.recoveryEmail ?? '').toLowerCase() !== (gewenst.herstelEmail ?? '').toLowerCase())
      {
         wijzigingen.herstelEmail = gewenst.herstelEmail ?? '';
      }
      // Een lid met recht op een account hoort niet geblokkeerd te zijn
      if (account.suspended)
      {
         wijzigingen.geblokkeerd = false;
      }
      return wijzigingen;
   }
}



