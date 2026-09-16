/**
 * Read a JSON response from a Documents endpoint, or fail with something a
 * person can act on.
 *
 * Kane, 2026-09-16: *"Documents Signing COE - for some reason I cannot set my
 * signature it will say JSON Token please investigate."*
 *
 * Every fetch in the Documents tab did `(await res.json()) as {...}` with no
 * guard. `Response.json()` throws a `SyntaxError` when the body is not JSON —
 * an HTML error page, a gateway timeout, a plain-text `Internal Server Error`,
 * a sign-in redirect — and the tab's catch blocks print `e.message` straight
 * into a toast. So the operator is shown the PARSER's complaint
 * (*"Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"*) instead of
 * the failure, which says nothing about what broke and cannot be searched for.
 *
 * Every route behind this tab answers JSON on every branch it knows about —
 * 401/403 from `deniedResponse`, 400 from a rejected signature, 422 `blocked`,
 * 409, 412, 500 `{ error }`. A NON-JSON body therefore means the request never
 * reached the handler, or the handler threw before it could answer. That is
 * worth reporting precisely, not flattening into a parse error.
 *
 * This ADDS information and swallows nothing: a failed request still throws,
 * and `{ error }` in a JSON body still wins. It only replaces an unreadable
 * message with a readable one.
 */

/** Characters of a non-JSON body quoted back in the error. Enough to recognise
 *  an HTML page or a proxy message; short enough for a toast. */
export const BODY_SNIPPET_CHARS = 120;

/** Collapse whitespace so a multi-line HTML page reads as one line in a toast. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty body)';
  return flat.length > BODY_SNIPPET_CHARS ? `${flat.slice(0, BODY_SNIPPET_CHARS)}…` : flat;
}

/**
 * Describe a non-JSON response: what was being attempted, the status, the
 * content type the server claimed, and what it actually sent.
 */
export function describeNonJsonResponse(params: {
  what: string;
  status: number;
  statusText?: string;
  contentType: string | null;
  body: string;
}): string {
  const { what, status, statusText, contentType, body } = params;
  const code = statusText ? `${status} ${statusText}` : `${status}`;
  const type = contentType?.split(';')[0]?.trim() || 'no content-type';
  return `${what} failed — the server answered ${code} with ${type}, not JSON: ${snippet(body)}`;
}

/**
 * Parse `res` as the Documents API's JSON envelope.
 *
 * Throws when the request failed, when the body carries `{ error }`, or when
 * the body is not JSON at all. `what` names the attempt in the operator's
 * words — "Saving your signature", "Generating the certificate".
 */
export async function readJsonResponse<T extends { error?: string }>(
  res: Response,
  what: string,
): Promise<T> {
  // Read as text FIRST: a body can only be consumed once, and on the non-JSON
  // path the raw text is the whole diagnostic.
  const text = await res.text();

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new Error(
      describeNonJsonResponse({
        what,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get('content-type'),
        body: text,
      }),
    );
  }

  // The route's own message always wins — it is written for this operator.
  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error) {
    throw new Error(parsed.error);
  }
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
  }
  return parsed;
}
