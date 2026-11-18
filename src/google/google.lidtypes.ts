import { HeliosLidTypes } from '../helios/helios.types';

/** Google groepen die door helios-sync beheerd worden (deel vóór de @, domein = GOOGLE_DOMAIN) */
export const GOOGLE_GROEP_LID      = 'leden';
export const GOOGLE_GROEP_DONATEUR = 'donateurs';
export const GOOGLE_BEHEERDE_GROEPEN = [GOOGLE_GROEP_LID, GOOGLE_GROEP_DONATEUR];

/**
 * LidTypes die een Google Workspace account krijgen, met de groep waar ze lid van worden.
 * LidTypes die hier niet in staan (DDWV, systeem accounts, zusterclub, ...) krijgen geen account.
 */
export const GOOGLE_LIDTYPE_GROEP: Partial<Record<HeliosLidTypes, string>> = {
  [HeliosLidTypes.STUDENTENLID]:  GOOGLE_GROEP_LID,
  [HeliosLidTypes.ERELID]:        GOOGLE_GROEP_LID,
  [HeliosLidTypes.LID]:           GOOGLE_GROEP_LID,
  [HeliosLidTypes.JEUGDLID]:      GOOGLE_GROEP_LID,
  [HeliosLidTypes.PRIVATE_OWNER]: GOOGLE_GROEP_LID,
  [HeliosLidTypes.VETERAAN]:      GOOGLE_GROEP_LID,
  [HeliosLidTypes.DONATEUR]:      GOOGLE_GROEP_DONATEUR,
};
