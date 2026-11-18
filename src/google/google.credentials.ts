import * as fs from 'node:fs';
import { JWT } from 'google-auth-library';

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}

/** Laadt het service account JSON bestand (GOOGLE_CREDENTIALS_PATH), of undefined als het niet bestaat */
export function laadGoogleCredentials(): GoogleServiceAccount | undefined {
  const path = process.env.GOOGLE_CREDENTIALS_PATH;
  return path && fs.existsSync(path)
    ? JSON.parse(fs.readFileSync(path, { encoding: 'utf8' }))
    : undefined;
}

/** Maakt een JWT client met domain-wide delegation namens `subject` */
export function maakGoogleAuthClient(
  credentials: GoogleServiceAccount | undefined,
  scopes: string[],
  subject: string | undefined,
): JWT {
  if (!credentials) {
    throw new Error('Google credentials not found');
  }

  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes,
    subject,
  });
}
