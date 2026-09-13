/**
 * Activity frames — the side channel that lets the Admin Penny console narrate
 * REAL work instead of a plausible-looking timer.
 *
 * Penny's chat routes stream `text/plain` token deltas straight into the
 * transcript, so the client has never known which tool the model was running.
 * A progress readout built on that blindness can only guess, and a console that
 * prints "searching the audit log…" while nothing of the sort is happening is
 * decoration wearing the costume of state (see People → Offboarded, whose
 * phases deliberately mirror what its route actually does).
 *
 * So the admin route interleaves frames with the text: a NUL, one compact JSON
 * object, a NUL. NUL is the delimiter because the model cannot emit one — it is
 * not legal inside a JSON string, so no reply can forge a frame or be mistaken
 * for one.
 *
 * The parser is deliberately pure and lives outside `server-only`, so both the
 * client hook and the tests can use it. Two rules it exists to guarantee:
 *
 *  1. A frame split across two network chunks is held, never half-parsed. The
 *     caller feeds `rest` back in front of the next chunk.
 *  2. A delimiter NEVER reaches the transcript. Everything downstream of the
 *     hook (the biz-report fence parser, the pipe-table pass, the Markdown
 *     pass) sees text that was already stripped.
 *
 * Routes that emit no frames are unaffected: `splitFrames` returns their text
 * byte-for-byte, which is what keeps the CEO and employee surfaces identical.
 */

/** Frame delimiter. Opens AND closes a frame — the parser alternates. */
export const FRAME_DELIM = '\u0000';

/**
 * Longest frame the parser will hold while waiting for its closing delimiter.
 * A stream that opens a frame and never closes it would otherwise buffer for
 * ever; past this the tail is dropped rather than flushed, because unparsable
 * NUL-laden junk must never be appended to an answer.
 */
export const MAX_FRAME_CHARS = 512;

/** One tool call starting, named exactly as the model asked for it. */
export interface PennyToolFrame {
  t: 'tool';
  name: string;
}

/**
 * One file the answer refers to, so the console can offer to open it.
 *
 * Keys are one letter because the whole frame must clear `MAX_FRAME_CHARS` even
 * when it straddles a chunk boundary (a held frame past that is DISCARDED, not
 * flushed). `r` is an opaque record ref — never a URL and never a storage path;
 * see `attachment-refs.ts` for why the credential is minted at open time.
 */
export interface PennyAttachmentFrame {
  t: 'att';
  /** `<source>~<record id>[~<slot>]`. */
  r: string;
  /** One-line operator label. */
  l: string;
  /** How the console should present it. */
  k: 'image' | 'pdf' | 'file';
}

export type PennyFrame = PennyToolFrame | PennyAttachmentFrame;

export function encodeFrame(frame: PennyFrame): string {
  return `${FRAME_DELIM}${JSON.stringify(frame)}${FRAME_DELIM}`;
}

const ATTACHMENT_KINDS = new Set(['image', 'pdf', 'file']);

/**
 * Unknown frame types resolve to null and are dropped, so a newer route can add
 * a frame kind without breaking an older client.
 *
 * Every field is checked on the way in. A half-valid frame is discarded whole
 * rather than admitted with a hole in it, because the consumers read these
 * fields without re-checking them.
 */
function decodeFrame(raw: string): PennyFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.t === 'tool') {
    if (typeof obj.name !== 'string' || !obj.name) return null;
    return { t: 'tool', name: obj.name };
  }

  if (obj.t === 'att') {
    if (typeof obj.r !== 'string' || !obj.r) return null;
    if (typeof obj.l !== 'string' || !obj.l) return null;
    if (typeof obj.k !== 'string' || !ATTACHMENT_KINDS.has(obj.k)) return null;
    return { t: 'att', r: obj.r, l: obj.l, k: obj.k as PennyAttachmentFrame['k'] };
  }

  return null;
}

export interface SplitResult {
  /** Frame-free text, safe to append to the transcript. */
  text: string;
  /** Frames decoded from this buffer, in arrival order. */
  frames: PennyFrame[];
  /**
   * An incomplete frame held back for the next chunk. Prepend it to whatever
   * arrives next. Empty when the buffer ended on a clean boundary.
   */
  rest: string;
}

export function splitFrames(buffer: string): SplitResult {
  // Overwhelmingly the common case (no route but Admin emits frames, and even
  // there most chunks are pure text) — skip the walk entirely.
  if (!buffer.includes(FRAME_DELIM)) return { text: buffer, frames: [], rest: '' };

  const frames: PennyFrame[] = [];
  let text = '';
  let i = 0;

  while (i < buffer.length) {
    const open = buffer.indexOf(FRAME_DELIM, i);
    if (open === -1) {
      text += buffer.slice(i);
      break;
    }
    text += buffer.slice(i, open);

    const close = buffer.indexOf(FRAME_DELIM, open + 1);
    if (close === -1) {
      const rest = buffer.slice(open);
      return { text, frames, rest: rest.length > MAX_FRAME_CHARS ? '' : rest };
    }

    const frame = decodeFrame(buffer.slice(open + 1, close));
    if (frame) frames.push(frame);
    i = close + 1;
  }

  return { text, frames, rest: '' };
}
