export interface LidRecord {
  ID: number;
  NAAM: string;
  VOORNAAM?: string;
  TUSSENVOEGSEL?: string;
  ACHTERNAAM?: string;
  INLOGNAAM: string;
  EMAIL?: string;
  LIDTYPE_ID: number;
  STATUSTYPE_ID?: number;
  VERWIJDERD: boolean;
  LIDNR?: string;
  MEDICAL?: string;
  MOBIEL?: string;
  NOODNUMMER?: string;
  AVATAR?: string;

  // Welke rol heeft het lid?
  BEHEERDER: boolean;
  LIERIST: boolean;
  LIERIST_IO: boolean;
  STARTLEIDER: boolean;
  INSTRUCTEUR: boolean;
  CIMT: boolean;
  DDWV_CREW: boolean;
  DDWV_BEHEERDER: boolean;
  STARTTOREN: boolean;
  ROOSTER: boolean;
  SLEEPVLIEGER: boolean;
  RAPPORTEUR: boolean;
  GASTENVLIEGER: boolean;
  TECHNICUS: boolean;

  // wachtwoord in klare taal.
  INGEVOERD_WACHTWOORD?: string;
}
