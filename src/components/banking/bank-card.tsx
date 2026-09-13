'use client';

import { useId, useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { Check, Copy, Eye, EyeOff, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import ProcessorLogo from '@/components/payroll-clerk/ProcessorLogo';
import { maskAccount } from '@/lib/banking/account-mask';
import { resolveBankBrand } from '@/lib/payment-catalog/banks';
import { bankCardInk, bankCardPalette, type BankCardPalette } from '@/lib/payment-catalog/bank-card-palette';
import { payProcessorLogoSrc } from '@/lib/payment-catalog/pay-processors';

/* ── The payee's bank card ──────────────────────────────────────────────────
   The revealed payout record, printed as the object it describes: a landscape
   card in the payee's own bank's colours, so the bank is recognised before a
   single field is read (Kane, 2026-09-11: "if it's GoTyme it will look like a
   GoTyme card with the info on it").

   **Every brand claim on it is measured, never recalled.** The logo comes from the
   Payment Catalog's declared table via `resolveBankBrand`, so this card and the
   Current Banks tab can never name two different banks; the colour comes from
   `bankCardPalette`, derived from that same logo file by
   `scripts/derive-bank-brand-colors.mts` and re-derived on every test run. A bank
   that ships no artwork (MariBank, Metrobank, Security Bank) and a spelling nobody
   has claimed ("Rizal Bank") both print the NEUTRAL card — same geometry, no brand
   on it. Inventing either for them is the invented equivalence
   `payment-catalog-current-banks.md` §2 forbids, and a wrong mark beside an account
   number is a confident lie about where money goes.

   **The account number is never reformatted.** No 4-4-4-4 grouping, whatever the
   card shape suggests: PH account numbers run 10–16 digits with no canonical
   grouping, and a clerk transcribing one has to read exactly what is stored.
   Tabular figures, verbatim — and the copy buttons hand over that same string.

   It does not theme. A card is a physical object; the same one lies on the page in
   light and dark, exactly as `EmployeeIdCard` reasons about its metal. Contrast is
   therefore fixed and provable — `bank-card-palette.test.ts` pins white on every
   face at ≥8.5:1 and both tinted inks at AA.

   **Two hosts, one card.** Accounting's People → Banking pane reveals a record it
   has already audited, so it passes nothing new and gets exactly the card it has
   always had. The employee's own Payout section passes `masked`, which prints the
   account number and the wire code as last-4 until they ask for them — the same
   exposure the payout form has always shown in its read state — and passes
   `animateIn={false}`, because that host animates the card's arrival itself. Both
   new props default to the shipped behaviour. */
export function BankCard({
  spelling,
  holder,
  account,
  swift,
  isAlternativeSlot,
  reduceMotion,
  masked = false,
  animateIn = true,
}: {
  spelling: string | null;
  holder: string | null;
  account: string | null;
  swift: string | null;
  isAlternativeSlot: boolean;
  reduceMotion: boolean;
  /**
   * Print the account number and the SWIFT code as last-4, with an in-card
   * reveal, and refuse to copy either until it is revealed.
   *
   * DEFAULT `false` — Accounting's shipped call site passes nothing and is
   * unchanged: no mask, no reveal control, copy enabled, same DOM.
   *
   * The reveal is client-side ONLY. The full value is already in the caller's
   * hands (the employee's own `employee_ids` row), so there is no route to call
   * and nothing to record: `/api/people/[email]/reveal-banking` writes an audit
   * row because it records someone reading ANOTHER person's record, and a payee
   * reading their own is not that event.
   */
  masked?: boolean;
  /**
   * Play the one-shot tilt-in on mount. DEFAULT `true` — Accounting's call site
   * is unchanged.
   *
   * A host whose own container animates the card into view passes `false`: the
   * motion wrapper is then not rendered at all, so there is no second entrance
   * competing with the first and no transform layer left alive off-screen.
   */
  animateIn?: boolean;
}) {
  const brand = useMemo(() => resolveBankBrand(spelling), [spelling]);
  const palette = useMemo(() => bankCardPalette(brand.key), [brand.key]);
  const ink = useMemo(() => bankCardInk(palette), [palette]);
  const logoSrc = payProcessorLogoSrc(brand.logo);
  // The card owns its own reveal. Nothing outside it needs to know — the values
  // it hides are the values it prints, and lifting the flag would let a second
  // copy of it disagree with this one.
  const [revealed, setRevealed] = useState(false);
  const hidden = masked && !revealed;

  // The record's own words come first; the official name is a second line only when
  // it says something the stored spelling does not ("BDO" → "BDO Unibank, Inc.").
  const printedName = spelling?.trim() || 'No bank on file';
  const officialLine =
    brand.officialName && brand.officialName.toLowerCase() !== printedName.toLowerCase()
      ? brand.officialName
      : null;

  const face = (
      <div
        style={{
          background: `linear-gradient(157deg, ${palette.surface} 0%, ${palette.surfaceDeep} 100%)`,
          boxShadow: '0 10px 24px -12px rgb(0 0 0 / 0.55), 0 2px 6px -2px rgb(0 0 0 / 0.3)',
        }}
        className="relative w-full max-w-[440px] overflow-hidden rounded-2xl p-4 sm:aspect-[1.586] sm:p-5"
      >
        {/* Raking light, then a milled bevel. Two layers is what separates a card
            from a rectangle with a gradient on it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 90% at 8% -10%, rgb(255 255 255 / 0.18) 0%, rgb(255 255 255 / 0.06) 38%, transparent 68%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14), inset 0 1px 0 0 rgb(255 255 255 / 0.22)' }}
        />
        {/* The brand's true colour, unmuted, in the one place no text sits on it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
          style={{ background: palette.accent, opacity: palette.branded ? 0.9 : 0.45 }}
        />

        <div className="relative flex h-full flex-col">
          {/* Issuer row — the mark sits where a card's issuer mark sits. */}
          <div className="flex items-start justify-between gap-3">
            {logoSrc ? (
              <ProcessorLogo
                monogram=""
                gradient="from-white/20 to-white/10"
                FallbackIcon={Landmark}
                fallback="icon"
                logoSrc={logoSrc}
                className="h-11 w-[88px] shrink-0"
              />
            ) : (
              // No artwork for this bank. A generic, unbranded mark — identical for
              // every bank without a logo, so it can never be read as one bank's.
              <span
                className="flex h-11 w-[88px] shrink-0 items-center justify-center rounded-xl"
                style={{ background: 'rgb(255 255 255 / 0.1)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)' }}
              >
                <Landmark className="h-4 w-4" style={{ color: ink.secondary }} />
              </span>
            )}
            {/* Rendered at all only when there is something to put in it, so a
                host that passes neither (Accounting's) emits the same DOM it
                always did. */}
            {(isAlternativeSlot || masked) && (
            <div className="flex shrink-0 items-center gap-2">
              {isAlternativeSlot && (
                // The exceptional slot is marked; the ordinary one needs no chip.
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ background: 'rgb(255 255 255 / 0.14)', color: ink.primary }}
                >
                  Alternative account
                </span>
              )}
              {masked && (
                // ONE control for the whole face, because one act of masking
                // covers both hidden values. Two toggles would let the account
                // number and the wire code beside it disagree about what is
                // currently on screen. Drawn in the card's own fixed ink, like
                // every other control on it — this face does not theme.
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  aria-pressed={revealed}
                  aria-label={revealed ? 'Hide your account number' : 'Show your account number'}
                  title={revealed ? 'Hide your account number' : 'Show your account number'}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2"
                  style={{
                    background: 'rgb(255 255 255 / 0.14)',
                    color: ink.primary,
                    ['--tw-ring-color' as string]: 'rgb(255 255 255 / 0.55)',
                  }}
                >
                  {revealed ? (
                    <EyeOff className="h-[11px] w-[11px]" />
                  ) : (
                    <Eye className="h-[11px] w-[11px]" />
                  )}
                  {revealed ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
            )}
          </div>

          <div className="mt-2 min-w-0">
            <p
              className="truncate text-[14px] font-semibold leading-tight"
              style={{ color: ink.primary }}
              title={printedName}
            >
              {printedName}
            </p>
            {officialLine && (
              <p className="truncate text-[11px] leading-tight" style={{ color: ink.secondary }}>
                {officialLine}
              </p>
            )}
          </div>

          <EmvChip />

          {/* Account number — the hero datum, and the reason anyone opens this.
              It and the wire code beside it are the two values `masked` hides;
              the bank's name and the account holder's are not secrets and are
              never masked on either host. */}
          <div className="mt-auto">
            <CardValue
              label="Account number"
              value={account}
              palette={palette}
              mono
              size="hero"
              masked={hidden}
            />
            <div className="mt-2 flex items-start justify-between gap-4">
              <CardValue label="Account holder" value={holder} palette={palette} upper />
              {swift && (
                <CardValue
                  label="SWIFT"
                  value={swift}
                  palette={palette}
                  mono
                  align="right"
                  masked={hidden}
                />
              )}
            </div>
          </div>
        </div>
      </div>
  );

  // A host that animates the card's arrival itself passes `animateIn={false}`,
  // and then there is no motion wrapper at all — not a zeroed transition. The
  // tilt fires on MOUNT, so under a shell where a pane can mount while it is not
  // on screen it would play where nobody is looking and settle before the
  // employee ever arrives. Removing the element removes the question.
  if (!animateIn) return <div className="mb-3">{face}</div>;

  return (
    <motion.div
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, rotateX: 7, scale: 0.975 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, rotateX: 0, scale: 1 }}
      // One authored moment: the card settles onto the page out of a slight tilt on
      // an exponential ease-out. Everything else in this block only fades.
      transition={{ duration: reduceMotion ? 0 : 0.55, ease: [0.16, 1, 0.3, 1] }}
      style={{ perspective: 900 }}
      className="mb-3"
    >
      {face}
    </motion.div>
  );
}

/**
 * One labelled value on the card face, with its own copy control.
 *
 * Copying is the whole reason this screen is open: a clerk reveals a payout record
 * to put the account number somewhere else, and re-typing 16 digits off a screen is
 * where transposition errors come from. The button hands over the stored string
 * EXACTLY — no grouping, no trimming of leading zeros, which `001234567890` has and
 * a spreadsheet would happily eat.
 *
 * A failed copy says so. The two existing copy helpers in this codebase both swallow
 * the rejection, and one of them flashes the confirmation tick even when the
 * clipboard API is absent — on a money field, a tick that means "possibly nothing
 * happened" is worse than no button.
 *
 * `masked` prints the value through the shared `maskAccount` rule and DISABLES the
 * copy button for exactly as long as it does. The button is still rendered, so the
 * reader can see that copying is a thing this value does once it is revealed — it
 * just cannot silently put bullets on the clipboard. The value itself is never
 * substituted: `text` stays the stored string, and only `display` changes.
 */
function CardValue({
  label,
  value,
  palette,
  mono,
  upper,
  size = 'normal',
  align = 'left',
  masked = false,
}: {
  label: string;
  value: string | null;
  palette: BankCardPalette;
  mono?: boolean;
  upper?: boolean;
  size?: 'normal' | 'hero';
  align?: 'left' | 'right';
  masked?: boolean;
}) {
  const ink = bankCardInk(palette);
  const [copied, setCopied] = useState(false);
  const text = value?.trim() ?? '';
  // The SAME rule the payout form masks with — see src/lib/banking/account-mask.ts.
  // `text` is the stored string and stays the stored string: only what is PRINTED
  // changes, so revealing is a re-render and never a re-read.
  const display = masked ? (maskAccount(text) ?? '') : text;

  const copy = async () => {
    // Disabled while masked. Handing `••••••7890` to the clipboard, silently, on
    // a money field is worse than offering no button at all — the paste lands in
    // a wire form and looks like an account number. Guarded here as well as on
    // the button, so a programmatic click cannot route around it.
    if (!text || masked) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error(`Could not copy the ${label.toLowerCase()} — select it and copy manually.`);
    }
  };

  return (
    <div className={align === 'right' ? 'min-w-0 text-right' : 'min-w-0'}>
      <div className={`flex items-center gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
        <span className="text-[9.5px] font-medium uppercase tracking-[0.14em]" style={{ color: ink.label }}>
          {label}
        </span>
        {text && (
          <button
            type="button"
            onClick={copy}
            disabled={masked}
            aria-label={
              masked
                ? `Show the ${label.toLowerCase()} before copying it`
                : copied
                  ? `${label} copied`
                  : `Copy ${label.toLowerCase()}`
            }
            title={
              masked
                ? `Show the ${label.toLowerCase()} before copying it`
                : copied
                  ? 'Copied'
                  : `Copy ${label.toLowerCase()}`
            }
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45"
            style={{
              color: copied ? ink.primary : ink.secondary,
              backgroundColor: copied ? 'rgb(255 255 255 / 0.22)' : 'rgb(255 255 255 / 0.08)',
              // The focus ring has to be visible on a coloured face, so it is drawn
              // in the card's own light rather than the app's zinc default.
              ['--tw-ring-color' as string]: 'rgb(255 255 255 / 0.55)',
            }}
          >
            {copied ? <Check className="h-[11px] w-[11px]" /> : <Copy className="h-[11px] w-[11px]" />}
          </button>
        )}
      </div>
      <p
        className={[
          'truncate',
          mono ? 'font-mono tabular-nums' : '',
          upper ? 'uppercase tracking-wide' : '',
          size === 'hero' ? 'text-[15px] font-medium' : 'text-[12.5px] font-medium',
        ].join(' ')}
        style={{
          color: display ? ink.primary : ink.label,
          ...(size === 'hero' ? { letterSpacing: '0.04em' } : null),
        }}
        // The tooltip prints what the eye prints. Leaving `text` here would hand
        // the full account number back on hover and undo the mask in one gesture.
        title={display || undefined}
      >
        {display || '—'}
      </p>
    </div>
  );
}

/**
 * The contact plate — the single most recognisable thing on a card, and the reason
 * this object reads as a card at a glance rather than as a coloured panel. Drawn,
 * never a glyph: a unicode stand-in would read as a typo at this size.
 *
 * Gold on every card, because every card has a gold chip; the brand tint lives in
 * the face behind it. An earlier pass ran the ACCENT through the middle of the
 * gradient, which turned the chip on every dark-branded bank (GoTyme, BDO, Cebuana)
 * into a muddy square with invisible black contacts — the brand colour is the one
 * thing a chip does not carry.
 *
 * The gradient id is per-instance. A hardcoded one is a latent collision: two cards
 * on a page would both point at the first card's definition.
 */
function EmvChip() {
  const faceId = useId();
  return (
    <svg aria-hidden viewBox="0 0 44 34" className="mt-2.5 h-[30px] w-[39px] shrink-0 self-start">
      <defs>
        <linearGradient id={faceId} x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#f7e9bd" />
          <stop offset="38%" stopColor="#d8b662" />
          <stop offset="62%" stopColor="#b8933f" />
          <stop offset="100%" stopColor="#eddba4" />
        </linearGradient>
      </defs>
      <rect x="0.7" y="0.7" width="42.6" height="32.6" rx="5" fill={`url(#${faceId})`} stroke="rgb(90 68 18 / 0.45)" strokeWidth="1.2" />
      {/* Contacts, in the plate's own darker gold so they read as milling rather
          than as ink laid over it. */}
      <g stroke="rgb(104 80 24 / 0.55)" strokeWidth="1.3" fill="none">
        <path d="M15 0.7v32.6M29 0.7v32.6M0.7 11.2h14.3M29 11.2h14.3M0.7 22.8h14.3M29 22.8h14.3" />
        <rect x="15" y="11.2" width="14" height="11.6" rx="1" />
      </g>
    </svg>
  );
}
