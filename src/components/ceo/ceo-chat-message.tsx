'use client';

import { useState, type ReactNode } from 'react';
import { Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { BIZ_REPORT_FENCE, parseBizReport, type BizReport } from '@/lib/ceo/biz-report';
import BizReportCard from './BizReportCard';
import {
  parseBlocks,
  parseInline,
  type BlockNode,
  type InlineNode,
} from '@/lib/penny/chat-markdown';

/**
 * Shared rendering for every Penny chat surface — the floating bubble
 * (`CeoChatBubble`, mounted on CEO / Admin / Employee) and the full-page Penny AI
 * tab (`BizAiTab`). Keep the parsing here so the surfaces never drift apart.
 *
 * Three layers, outermost first:
 *   1. ```biz-report fences  → a download card (CEO reports).
 *   2. GitHub pipe tables    → real <table>s.
 *   3. everything else       → the small Markdown subset in `chat-markdown.ts`
 *                              (bold, italic, strike, code, bullets, numbered
 *                              lists, headings, `***` rules).
 *
 * Layer 3 replaced verbatim rendering on 2026-08-19. The original design told the
 * model to emit no Markdown and printed whatever arrived; Haiku ignored that and
 * employees saw raw `**` and `***` (Kane: *"remove the *** it's a lot and looks
 * ugly AF"*). Instructing a text generator not to write Markdown is a request,
 * not a guarantee — so the renderer handles the subset instead. Order matters:
 * fences and tables are consumed BEFORE the Markdown pass ever sees the text, so
 * JSON inside a report block is never reformatted.
 */

type Align = 'left' | 'right' | 'center';
type Segment =
  | { type: 'text'; text: string }
  | { type: 'table'; headers: string[]; aligns: Align[]; rows: string[][] }
  | { type: 'report'; report: BizReport | null; pending: boolean };

const FENCE_OPEN = /^```\s*([\w-]*)\s*$/;

/**
 * Best-effort close of a truncated JSON object: if a reply got cut off mid-block
 * (e.g. the token budget ran out before the closing fence streamed), balance any
 * open strings/brackets so the validator can still salvage a usable report.
 */
function repairJson(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/,\s*$/, ''); // drop a dangling comma left by truncation
  while (stack.length) s += stack.pop();
  return s;
}

/** Parse a report block, repairing a truncated one if the raw parse fails. */
function parseReportBlock(jsonText: string): BizReport | null {
  return parseBizReport(jsonText) ?? parseBizReport(repairJson(jsonText));
}

/** Split a markdown table row into trimmed cells (tolerates missing outer pipes). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const SEP_CELL = /^:?-{1,}:?$/;
function isSeparator(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c.replace(/\s/g, '')));
}

/**
 * Parse assistant text into plain-text and GitHub-style-table segments. Runs on
 * every streamed update; a half-streamed table simply renders as text until its
 * separator row arrives, then snaps into a table.
 */
function parseSegments(input: string, streaming: boolean): Segment[] {
  const lines = input.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) segs.push({ type: 'text', text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Downloadable report block: ```biz-report … ``` → a report segment.
    const fence = FENCE_OPEN.exec(line.trim());
    if (fence && fence[1] === BIZ_REPORT_FENCE) {
      flush();
      const jsonLines: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '```') {
          closed = true;
          break;
        }
        jsonLines.push(lines[j]);
      }
      const jsonText = jsonLines.join('\n').trim();
      if (!closed) {
        // While the reply is still streaming, the closing fence simply hasn't
        // arrived yet → show the placeholder. But once streaming has ENDED an
        // unclosed fence means the block was truncated (e.g. token cap) — don't
        // hang on "Preparing report…"; try to salvage the partial JSON, and
        // fall back to a clear message if it can't be built.
        if (streaming) {
          segs.push({ type: 'report', report: null, pending: true });
        } else {
          segs.push({ type: 'report', report: parseReportBlock(jsonText), pending: false });
        }
        return segs; // everything after is inside this (unfinished) block
      }
      segs.push({ type: 'report', report: parseReportBlock(jsonText), pending: false });
      i = j;
      continue;
    }

    const next = lines[i + 1];
    if (line.includes('|') && next != null && isSeparator(next)) {
      flush();
      const headers = splitRow(line);
      const aligns: Align[] = splitRow(next).map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : 'left';
      });
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        if (!lines[j].includes('|') || isSeparator(lines[j])) break;
        rows.push(splitRow(lines[j]));
      }
      segs.push({ type: 'table', headers, aligns, rows });
      i = j - 1;
    } else {
      buf.push(line);
    }
  }
  flush();
  return segs;
}

const ALIGN_CLASS: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/* ── Markdown subset → React ──────────────────────────────────────────────── */

/** Inline nodes as elements. Data in, elements out — no HTML string anywhere. */
function renderInline(nodes: InlineNode[], keyPrefix = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case 'text':
        return <span key={key}>{n.text}</span>;
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-zinc-900 dark:text-white">
            {renderInline(n.children, `${key}.`)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(n.children, `${key}.`)}</em>;
      case 'strongEm':
        return (
          <strong key={key} className="font-semibold italic text-zinc-900 dark:text-white">
            {renderInline(n.children, `${key}.`)}
          </strong>
        );
      case 'strike':
        return (
          <span key={key} className="line-through opacity-70">
            {renderInline(n.children, `${key}.`)}
          </span>
        );
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.92em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {n.text}
          </code>
        );
    }
  });
}

/** One text segment's blocks. Spacing is tight — this lives in a chat bubble. */
function renderBlocks(blocks: BlockNode[], keyPrefix: string): ReactNode {
  return blocks.map((b, i) => {
    const key = `${keyPrefix}b${i}`;
    switch (b.type) {
      case 'paragraph':
        return (
          <p key={key} className="break-words">
            {b.lines.map((line, li) => (
              // Soft line breaks inside a paragraph are preserved, matching the
              // old whitespace-pre-wrap behaviour for multi-line answers.
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${key}.${li}.`)}
              </span>
            ))}
          </p>
        );
      case 'heading':
        // Rendered as a compact label, not an <h_>: these are section markers
        // inside a message, and a real heading's scale would fight the bubble.
        return (
          <p
            key={key}
            className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
          >
            {renderInline(b.children, `${key}.`)}
          </p>
        );
      case 'bullets':
        return (
          <ul key={key} className="list-outside list-disc space-y-0.5 pl-4">
            {b.items.map((item, ii) => (
              <li key={ii} className="break-words">
                {renderInline(item, `${key}.${ii}.`)}
              </li>
            ))}
          </ul>
        );
      case 'ordered':
        return (
          <ol
            key={key}
            start={b.start}
            className="list-outside list-decimal space-y-0.5 pl-4 tabular-nums"
          >
            {b.items.map((item, ii) => (
              <li key={ii} className="break-words">
                {renderInline(item, `${key}.${ii}.`)}
              </li>
            ))}
          </ol>
        );
      case 'rule':
        return (
          <hr
            key={key}
            className="my-1 border-0 border-t border-zinc-200/80 dark:border-zinc-700/60"
          />
        );
    }
  });
}

/**
 * Renders an assistant message: plain text, with pipe tables shown as real
 * tables and ```biz-report blocks as a download card. `streaming` must reflect
 * whether this reply is still arriving — it's what stops an unfinished report
 * block from getting stuck on "Preparing report…" after the stream ends.
 */
export function AssistantContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const segments = parseSegments(text, streaming);
  return (
    <div className="space-y-2">
      {segments.map((seg, idx) =>
        seg.type === 'text' ? (
          <div key={idx} className="space-y-1.5 break-words">
            {renderBlocks(parseBlocks(seg.text), `${idx}.`)}
          </div>
        ) : seg.type === 'report' ? (
          seg.pending ? (
            <div
              key={idx}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fuchsia-200/80 bg-fuchsia-50/60 px-2.5 py-1.5 text-[12px] text-fuchsia-700 dark:border-fuchsia-900/40 dark:bg-fuchsia-950/20 dark:text-fuchsia-300"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Preparing report…
            </div>
          ) : seg.report ? (
            <BizReportCard key={idx} report={seg.report} />
          ) : (
            <div key={idx} className="text-[12px] italic text-zinc-400">
              (The report was cut off before it finished — ask me to try again, or
              for a shorter date range.)
            </div>
          )
        ) : (
          <div key={idx} className="-mx-1 overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px] leading-snug">
              <thead>
                <tr>
                  {seg.headers.map((h, k) => (
                    <th
                      key={k}
                      className={`whitespace-nowrap border-b border-fuchsia-200/80 px-2.5 py-1.5 font-semibold text-zinc-600 dark:border-fuchsia-900/50 dark:text-zinc-300 ${ALIGN_CLASS[seg.aligns[k] ?? 'left']}`}
                    >
                      {/* Cells get the INLINE pass only — a cell is never a
                          block, and running the block parser here would let a
                          `-` cell parse as a bullet. */}
                      {renderInline(parseInline(h), `${idx}.h${k}.`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seg.rows.map((row, ri) => (
                  <tr key={ri} className="odd:bg-fuchsia-50/40 dark:odd:bg-white/[0.03]">
                    {seg.headers.map((_, ci) => (
                      <td
                        key={ci}
                        className={`whitespace-nowrap border-b border-zinc-100 px-2.5 py-1.5 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200 ${ALIGN_CLASS[seg.aligns[ci] ?? 'left']}`}
                      >
                        {renderInline(parseInline(row[ci] ?? ''), `${idx}.${ri}.${ci}.`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Thumbs up/down feedback for one assistant reply, with an optional comment box
 * on a thumbs-down. Self-contained: owns the comment input state and calls
 * `onRate(rating, comment?)`. Used by both chat surfaces.
 */
export function MessageFeedback({
  rating,
  onRate,
}: {
  rating: 'up' | 'down' | null | undefined;
  onRate: (rating: 'up' | 'down', comment?: string) => void;
}) {
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');

  const submitDown = () => {
    onRate('down', comment.trim() || undefined);
    setCommenting(false);
  };

  const btn = (active: boolean) =>
    `flex h-6 w-6 items-center justify-center rounded-md transition ${
      active
        ? 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300'
        : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800'
    }`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            onRate('up');
            setCommenting(false);
          }}
          aria-label="Good response"
          title="Good response"
          className={btn(rating === 'up')}
        >
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            onRate('down');
            setCommenting(true);
            setComment('');
          }}
          aria-label="Bad response"
          title="Bad response"
          className={btn(rating === 'down')}
        >
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {commenting && (
        <div className="flex items-center gap-1">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitDown();
              else if (e.key === 'Escape') setCommenting(false);
            }}
            placeholder="What was off? (optional)"
            className="w-52 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11.5px] text-zinc-700 outline-none focus:border-fuchsia-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          />
          <button
            type="button"
            onClick={submitDown}
            className="rounded-md bg-fuchsia-600 px-2 py-1 text-[11.5px] font-medium text-white transition hover:bg-fuchsia-700"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
