/**
 * Turn any error value into a short, display-safe message.
 *
 * Why this exists: supabase-js / postgrest-js (v2.101.x), on a non-2xx response
 * with a NON-JSON body, sets `error.message` to the RAW response body. When
 * Supabase's edge is down that body is the full Cloudflare "522: Connection timed
 * out" HTML page. If a route echoes `{ error: error.message }` and a component
 * renders that string, the entire HTML page paints into the UI as text. This
 * helper collapses any HTML / Cloudflare error page (and the res.json()-on-HTML
 * SyntaxError) into a friendly one-liner, and hard-caps everything else so no raw
 * body can ever flood a card. Pure — safe to import in both client and server.
 */

const CF_STATUS_PHRASE: Record<number, string> = {
  520: 'the server returned an unexpected response',
  521: 'the server is down',
  522: 'the connection timed out',
  523: 'the server is unreachable',
  524: 'the server took too long to respond',
};

const HTML_MARKER =
  /<!doctype|<html|<head|<body|cf-error|cf-wrapper|cloudflare|error code\s+\d{3}|connection timed out|web server is (down|returning an unknown error)/i;

/** True when the string looks like an HTML / Cloudflare error page rather than a message. */
export function looksLikeHtmlError(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  return t.startsWith('<') || HTML_MARKER.test(t);
}

/** Best-effort HTTP status embedded in a Cloudflare error page ("Error code 522" / "522: …"). */
export function detectHttpStatus(raw: string): number | null {
  const labelled = /error code\s+(\d{3})/i.exec(raw);
  if (labelled) return parseInt(labelled[1], 10);
  const fivexx = /\b(5\d{2})\b/.exec(raw);
  if (fivexx) return parseInt(fivexx[1], 10);
  return null;
}

function toText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message ?? '';
  if (typeof raw === 'object') {
    const m = (raw as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(raw);
}

/**
 * Coerce any error-ish value (string, Error, PostgrestError-like {message}, null,
 * or anything) into a short display-safe string.
 */
export function cleanErrorMessage(
  raw: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const text = toText(raw).trim();
  if (!text) return fallback;

  // res.json() choking on an HTML body: "Unexpected token '<', "<!DOCTYPE"… is not valid JSON".
  if (/is not valid json/i.test(text) && /(<!doctype|token '<'|<)/i.test(text)) {
    return "Can't reach the server right now. Please retry.";
  }

  if (looksLikeHtmlError(text)) {
    const status = detectHttpStatus(text);
    if (status && CF_STATUS_PHRASE[status]) {
      return `Can't reach the server — ${CF_STATUS_PHRASE[status]} (HTTP ${status}).`;
    }
    if (status) return `Can't reach the server (HTTP ${status}).`;
    return "Can't reach the server right now. Please retry.";
  }

  // Normal short error — pass through, but never let an undetected giant body flood the UI.
  return text.length > 200 ? text.slice(0, 197) + '…' : text;
}
