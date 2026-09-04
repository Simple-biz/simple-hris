'use client';

import React, { useEffect, useState } from 'react';
import type { IdCard } from '@/lib/employee/id-card';

/**
 * The employee's company ID badge — Employee portal -> Profile -> ID.
 *
 * Purely presentational: every value arrives resolved from `buildIdCard`, so this
 * file decides nothing about identity and cannot disagree with the Overview
 * section beside it.
 *
 * ## Why it looks the way it does
 *
 * **CR80 upright.** `aspect-ratio: 54/85.6` is the ID-1 badge standard. Type and
 * geometry are sized in `cqw` against an `@container`, so the whole card scales
 * as one object instead of drifting out of proportion at narrow widths.
 *
 * **Flat, on purpose (Kane, 2026-09-04).** No shadow, no gradient, no inner
 * highlight, no perspective. Separation comes from overlap and a grey hairline —
 * that hairline is the only thing letting the navy header read as a shape rather
 * than a bleed, so do not remove it.
 *
 * **Navy dominates; orange is fill-only.** The header panel and footer band are
 * `#27285A` (sampled from `public/simple-logo.png`). Orange `#F26F07` appears
 * exactly twice, both as fills: the block bleeding off the top edge and the rule
 * under the name. **Never set orange as a text colour** — it is 2.95:1 on white,
 * under AA even for large text, and PRODUCT.md targets AA.
 *
 * **The footer band has a straight top edge.** An earlier comp sloped it, and its
 * high corner sat *above* the record block, so a long address ran underneath the
 * navy. The straight edge plus `mt-auto` on the record is what makes overlap
 * structurally impossible — a third address line grows into the gap, not the band.
 *
 * **It never themes.** A printed object does not have a dark mode: white ground,
 * navy geometry, orange accent, identical in both. Only the surface behind it
 * changes, so there is deliberately not a single `dark:` variant below.
 */
export default function EmployeeIdCard({ card }: { card: IdCard }) {
  // Walk the photo ladder the way EmployeeAvatar does (upload, then Google SSO),
  // dropping to the next candidate on a load error so a dead URL degrades to
  // initials instead of a broken frame.
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [card.photoSources.join('|')]);
  const photoSrc = card.photoSources[sourceIndex] ?? null;

  return (
    <div className="@container w-full max-w-[372px]">
      <div className="relative aspect-[54/85.6] overflow-hidden rounded-[5cqw] border border-[#E4E4EE] bg-white">
        {/* ── header: one navy panel, one grey hairline, one orange block ── */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[46%]">
          <span
            className="absolute inset-0 block bg-[#27285A]"
            style={{ clipPath: 'polygon(0 0, 100% 0, 100% 74%, 0 92%)' }}
          />
          <span
            className="absolute inset-0 block bg-[#E4E4EE]"
            style={{ clipPath: 'polygon(0 92%, 100% 74%, 100% 77.5%, 0 95.5%)' }}
          />
          <span className="absolute -top-[7cqw] right-[8cqw] block h-[23cqw] w-[15cqw] rounded-b-[7.5cqw] bg-[#F26F07]" />
        </div>

        {/* ── footer band: straight top edge, see the header comment ── */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[11%] bg-[#27285A]" />

        {/* The serial hides entirely when there is no employee_id — it derives from
            start_date, so a blank date means no ID has been minted yet. */}
        {card.employeeId && (
          <div className="absolute inset-x-0 bottom-0 flex h-[11%] items-center gap-[2.4cqw] px-[7cqw]">
            <span className="text-[2.3cqw] font-bold uppercase tracking-[0.2em] text-[#A9AAD0]">
              Employee ID
            </span>
            <span className="ml-auto font-mono text-[3.4cqw] font-semibold tracking-[0.05em] tabular-nums text-white">
              {card.employeeId}
            </span>
          </div>
        )}

        <div className="relative z-10 flex h-full flex-col items-center px-[7cqw] pb-[21cqw] pt-[6cqw]">
          {/* ui-standards §6.4 — dark-on-transparent artwork always sits on a
              WHITE plate, object-contain, and never with mix-blend. */}
          <span className="flex self-start rounded-[1.6cqw] bg-white px-[2.2cqw] py-[1.5cqw]">
            <img
              src="/simple-logo.png"
              alt="Simple"
              className="block h-[6.4cqw] w-auto object-contain"
            />
          </span>

          {/* Straddles the header's diagonal — that overlap is what stops the
              navy reading as a plain banner. */}
          <div className="mt-[27cqw] grid h-[35cqw] w-[35cqw] shrink-0 place-items-center overflow-hidden rounded-full border-[1.1cqw] border-white bg-[#EDEDF3]">
            {photoSrc ? (
              <img
                src={photoSrc}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setSourceIndex((i) => i + 1)}
              />
            ) : (
              <span className="text-[11cqw] font-semibold text-[#27285A]" aria-hidden>
                {card.initials}
              </span>
            )}
          </div>

          <h3 className="mt-[5cqw] text-balance text-center text-[7cqw] font-semibold leading-[1.12] tracking-[-0.02em] text-[#27285A]">
            {card.name}
          </h3>

          <span aria-hidden className="mb-[2.6cqw] mt-[3cqw] block h-[0.9cqw] w-[10cqw] bg-[#F26F07]" />

          {/* Already through formatDeptLabel. Omitted rather than printed empty. */}
          {card.department && (
            <div className="text-center text-[2.75cqw] font-bold uppercase leading-[1.5] tracking-[0.19em] text-[#27285A]/70">
              {card.department}
            </div>
          )}

          {/* mt-auto anchors the record above the footer band. */}
          <dl className="mt-auto grid w-full grid-cols-[max-content_1fr] gap-x-[3.4cqw] gap-y-[3cqw] border-t border-[#E4E4EE] pt-[5cqw]">
            <Line label="Email" value={card.workEmail} />
            <Line label="Started" value={card.startDate} mono />
            <Line label="Address" value={card.address} />
          </dl>
        </div>
      </div>
    </div>
  );
}

/**
 * A label/value pair. The value wraps to as many lines as it needs — an address
 * is never truncated, because a partial address on an identity document is worse
 * than an absent one.
 */
function Line({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-[2.5cqw] font-bold uppercase leading-[1.52] tracking-[0.14em] text-[#27285A]">
        {label}
      </dt>
      <dd
        className={[
          'm-0 min-w-0 break-words text-[3.15cqw] font-medium leading-[1.45]',
          value ? 'text-[#34364F]' : 'text-[#8A8CA2]',
          mono && value ? 'font-mono tabular-nums' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value ?? 'Not on file'}
      </dd>
    </>
  );
}
