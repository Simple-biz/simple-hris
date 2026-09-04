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
 * **Milled metal (Kane, 2026-09-04, superseding the earlier flat rule).** Three
 * things do the work, and none of them is a drop shadow: a raking-light gradient
 * on every surface, anisotropic brush lines, and one slow specular sweep. The
 * brush lines are what actually read as metal — a gradient alone reads as a
 * gradient.
 *
 * **The sweep passes UNDER the content, never over it.** That is a contrast rule
 * wearing a visual disguise: glyphs sit above the sheen layer, so no text is ever
 * composited through it. The sheen still lightens the navy behind the footer
 * serial, which is why the sweep also STOPS at the footer band: that band carries
 * the only light-on-dark text, and at peak sheen no mid-tone ink survives on
 * lightened navy. Tests prove both bounds. It also keeps the sheen off the
 * wordmark, which must never be blended (ui-standards §6.4).
 *
 * **Navy dominates; orange is fill-only.** Orange is 2.95:1 on white — under AA
 * even for large text — so it appears only as the block bleeding off the top edge
 * and the rule under the name. **Never set it as a text colour.**
 *
 * **The footer band has a straight top edge.** An earlier comp sloped it, and its
 * high corner sat above the record block, so a long address ran underneath the
 * navy. The straight edge plus `mt-auto` on the record is what makes overlap
 * structurally impossible — a third address line grows into the gap, not the band.
 *
 * **It never themes.** A metal object does not have a dark mode: same surface in
 * both, only what sits behind it changes. There is deliberately not one `dark:`
 * variant below.
 *
 * The PNG export (`src/lib/employee/id-card-render.ts`) paints the same metal
 * statically, with the sweep frozen mid-card. Change the ramp here, change it
 * there — `ID_CARD_METAL` holds the shared values.
 */

/** Raking-light ramps and the sheen cap. Mirrored by the PNG painter. */
const NAVY_METAL = 'linear-gradient(158deg, #35366F 0%, #27285A 44%, #1E1F48 100%)';
const SILVER_METAL = 'linear-gradient(162deg, #FFFFFF 0%, #F7F8FC 48%, #ECEDF4 100%)';
const ORANGE_METAL = 'linear-gradient(160deg, #FF8B2D 0%, #F26F07 52%, #D75E02 100%)';

/** Anisotropic brush. Fine, near-horizontal, barely there — metal, not corduroy. */
const BRUSH_LIGHT = 'repeating-linear-gradient(96deg, rgba(255,255,255,0.05) 0 1px, rgba(255,255,255,0) 1px 3px)';
const BRUSH_DARK = 'repeating-linear-gradient(96deg, rgba(39,40,90,0.032) 0 1px, rgba(39,40,90,0) 1px 3px)';

export default function EmployeeIdCard({ card }: { card: IdCard }) {
  // Walk the photo ladder the way EmployeeAvatar does (upload, then Google SSO),
  // dropping to the next candidate on a load error so a dead URL degrades to
  // initials instead of a broken frame.
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [card.photoSources.join('|')]);
  const photoSrc = card.photoSources[sourceIndex] ?? null;

  return (
    <div className="@container w-full max-w-[372px]">
      <style>{`
        @keyframes idCardSheen {
          0%   { transform: translateX(-190%) rotate(8deg); }
          52%  { transform: translateX(330%)  rotate(8deg); }
          100% { transform: translateX(330%)  rotate(8deg); }
        }
        /* Reduced motion parks the sweep instead of deleting it: the card keeps
           its caught-the-light look, it just stops moving. */
        @media (prefers-reduced-motion: reduce) {
          .id-card-sheen {
            animation: none !important;
            transform: translateX(58%) rotate(8deg) !important;
            opacity: 0.5;
          }
        }
      `}</style>

      <div
        className="relative aspect-[54/85.6] overflow-hidden rounded-[5cqw] border border-[#DEDFEA]"
        style={{ backgroundImage: `${BRUSH_DARK}, ${SILVER_METAL}` }}
      >
        {/* ── header: navy plate, grey hairline, one orange block ── */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[46%]">
          <span
            className="absolute inset-0 block"
            style={{
              backgroundImage: `${BRUSH_LIGHT}, ${NAVY_METAL}`,
              clipPath: 'polygon(0 0, 100% 0, 100% 74%, 0 92%)',
            }}
          />
          {/* Milled top edge — the lit lip of a metal plate, 1px, not a bevel. */}
          <span
            className="absolute inset-x-0 top-0 block h-[0.3cqw] bg-white/25"
            style={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' }}
          />
          <span
            className="absolute inset-0 block bg-[#E4E4EE]"
            style={{ clipPath: 'polygon(0 92%, 100% 74%, 100% 77.5%, 0 95.5%)' }}
          />
          <span
            className="absolute -top-[7cqw] right-[8cqw] block h-[23cqw] w-[15cqw] rounded-b-[7.5cqw]"
            style={{ backgroundImage: ORANGE_METAL }}
          />
        </div>

        {/* ── footer band: straight top edge, see the header comment ── */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[11%]"
          style={{ backgroundImage: `${BRUSH_LIGHT}, ${NAVY_METAL}` }}
        >
          <span className="absolute inset-x-0 top-0 block h-[0.3cqw] bg-white/[0.18]" />
        </div>

        {/* ── the sweep. Above the metal, below every glyph, and it STOPS at the
            footer band (h-[89%] mirrors ID_CARD_GEOMETRY.sheen.height). The band
            holds the only light-on-dark text on the card, and at peak sheen no
            mid-tone ink survives on lightened navy — the periwinkle EMPLOYEE ID
            label falls to 2.2:1. Brightening the ink cannot fix a ground that
            light, so the sheen never reaches it. ── */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[89%] overflow-hidden">
          <span
            className="id-card-sheen absolute -top-1/2 left-0 block h-[200%] w-[42%] will-change-transform"
            style={{
              backgroundImage:
                'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.08) 34%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.08) 66%, rgba(255,255,255,0) 100%)',
              animation: 'idCardSheen 9s cubic-bezier(0.45, 0, 0.55, 1) infinite',
            }}
          />
        </div>

        {/* The serial hides entirely when there is no employee_id — it derives from
            start_date, so a blank date means no ID has been minted yet. */}
        {card.employeeId && (
          <div className="absolute inset-x-0 bottom-0 z-[3] flex h-[11%] items-center gap-[2.4cqw] px-[7cqw]">
            <span className="text-[2.3cqw] font-bold uppercase tracking-[0.2em] text-[#A9AAD0]">
              Employee ID
            </span>
            <span className="ml-auto font-mono text-[3.4cqw] font-semibold tracking-[0.05em] tabular-nums text-white">
              {card.employeeId}
            </span>
          </div>
        )}

        <div className="relative z-[4] flex h-full flex-col items-center px-[7cqw] pb-[21cqw] pt-[6cqw]">
          {/* ui-standards §6.4 — dark-on-transparent artwork always sits on a
              WHITE plate, object-contain, and never with mix-blend. The plate is
              flat white on purpose: a gradient under the wordmark would tint it. */}
          <span className="flex self-start rounded-[1.6cqw] bg-white px-[2.2cqw] py-[1.5cqw]">
            <img
              src="/simple-logo.png"
              alt="Simple"
              className="block h-[6.4cqw] w-auto object-contain"
            />
          </span>

          {/* Straddles the header's diagonal — that overlap is what stops the
              navy reading as a plain banner. The ring is milled steel, not a
              flat stroke, so the portrait belongs to the same object. */}
          <div
            className="mt-[27cqw] grid h-[35cqw] w-[35cqw] shrink-0 place-items-center rounded-full p-[1.1cqw]"
            style={{ backgroundImage: 'linear-gradient(150deg, #FFFFFF 0%, #D7D9E6 46%, #FFFFFF 100%)' }}
          >
            <div
              className="grid h-full w-full place-items-center overflow-hidden rounded-full"
              style={{ backgroundImage: SILVER_METAL }}
            >
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
          </div>

          <h3 className="mt-[5cqw] text-balance text-center text-[7cqw] font-semibold leading-[1.12] tracking-[-0.02em] text-[#27285A]">
            {card.name}
          </h3>

          <span
            aria-hidden
            className="mb-[2.6cqw] mt-[3cqw] block h-[0.9cqw] w-[10cqw] rounded-full"
            style={{ backgroundImage: ORANGE_METAL }}
          />

          {/* Already through formatDeptLabel. Omitted rather than printed empty. */}
          {card.department && (
            <div className="text-center text-[2.75cqw] font-bold uppercase leading-[1.5] tracking-[0.19em] text-[#27285A]/70">
              {card.department}
            </div>
          )}

          {/* mt-auto anchors the record above the footer band. */}
          <dl className="mt-auto grid w-full grid-cols-[max-content_1fr] gap-x-[3.4cqw] gap-y-[3cqw] border-t border-[#D9DAE6] pt-[5cqw]">
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
 *
 * The "Not on file" ink is `#666881`, not a lighter grey. It is measured against the
 * DARKEST stop of the silver ramp, not against white — the metal body is not white,
 * and a grey that clears AA on paper can fail on the card. A missing value is still
 * a value someone has to read.
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
          value ? 'text-[#34364F]' : 'text-[#666881]',
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
