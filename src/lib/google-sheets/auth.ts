import crypto from 'node:crypto';

/**
 * Service-account access token for Google APIs via the JWT-bearer flow.
 * Hand-rolled with Node's `crypto` so we don't need to pull in `googleapis`
 * just to read one sheet.
 *
 * https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests
 */

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Returns a fresh access token (cached in-memory until ~30s before expiry).
 * Throws if the env credentials are missing or the token exchange fails.
 */
export async function getServiceAccountAccessToken(scope: string): Promise<string> {
  const clientEmail = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY ?? '';
  // Vercel/CI typically store the key with literal `\n` escapes — restore real newlines.
  const privateKey = rawKey.replace(/\\n/g, '\n').trim();

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Google service account env vars missing — set GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL and GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY in .env.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 30 > now) {
    return cached.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;

  let signatureB64Url: string;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signatureB64Url = base64UrlEncode(signer.sign(privateKey));
  } catch (e) {
    throw new Error(
      `Could not sign JWT with the service account key. Verify GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY is the full PEM block. Underlying: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const jwt = `${signingInput}.${signatureB64Url}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    cache: 'no-store',
  });

  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(
      `Google token exchange failed (${tokenRes.status}): ${
        tokenJson.error_description ?? tokenJson.error ?? tokenRes.statusText
      }`,
    );
  }

  cached = {
    token: tokenJson.access_token,
    expiresAt: now + (tokenJson.expires_in ?? 3600),
  };
  return tokenJson.access_token;
}
