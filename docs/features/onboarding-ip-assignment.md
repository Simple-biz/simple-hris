# Onboarding IP Assignment + form preview mode

> **Status:** Built 2026-06-16 and **live**. Migration #73 is **APPLIED** —
> verified against production 2026-08-11 by `scripts/audit-pending-migrations.mts`
> ([probe](../audits/2026-08-11-pending-migrations-probe.md)). The file also
> moved: it lives under `references/sql/alter/`, not the path the section below
> cites.

A standalone **"Intellectual Property Assignment, Talent Release, and Copyright
Waiver"** is now the **first step** of the public onboarding flow, signed before
any other paperwork. On submit the server renders a filled PDF and stores it
alongside the W-8BEN; HR reviews it via a dedicated tab + signed-URL download.
A no-save **preview mode** (`/onboarding/preview`) lets HR page through the whole
form and generate a real sample PDF without writing anything to the database.

---

## The agreement step

The IP Assignment is **step 0** of the wizard. `STEP_TITLES` in
[`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) is:

```
Intellectual Property → Welcome → Non-Solicitation → Privacy Agreement
→ W-8BEN Tax Form → Payment Method → Contract Worker Agreement
```

The `StepIpAssignment` component renders, in order:

1. **The full document** — scrollable copy from `IntellectualPropertyText`
   ([`src/components/onboarding/agreement-texts.tsx`](../../src/components/onboarding/agreement-texts.tsx)).
2. **An acknowledgement checkbox** — toggles `form.ip_agreement_agreed`; its label
   is the shared `IP_ASSIGNMENT_ACKNOWLEDGEMENT` constant.
3. **A PARTICIPANT block** — `Name` text input, a canvas `SignaturePad` (drawn
   signature captured as a PNG data URL), and a **read-only Date** field.

Step validation (`validateStep(0)`) requires a name, a ticked checkbox, and a
signature before the hire can advance.

### Single source of truth for the copy

[`src/lib/onboarding/ip-assignment-text.ts`](../../src/lib/onboarding/ip-assignment-text.ts)
holds the title, intro paragraphs, the eight numbered sections
(`IP_ASSIGNMENT_SECTIONS`), and the acknowledgement string. The same module feeds
**three surfaces** so they can never drift:

- the public form (`IntellectualPropertyText`),
- the HR submission-detail modal (same component, see [HR surfaces](#hr-surfaces)),
- the server PDF generator.

The copy is kept ASCII-only (straight quotes, `-` not en/em dashes) so it renders
cleanly through pdf-lib's WinAnsi Helvetica encoding.

### The date auto-stamps client-side, local time

The `Date` field is read-only and stamped to the hire's **local** day, not the
server's UTC day. An effect in `page.tsx` fills `ip_agreement_date` with
`todayLocalIso()` only when empty (so a prior-submitted date is preserved):

```ts
useEffect(() => {
  setForm((f) => (f.ip_agreement_date ? f : { ...f, ip_agreement_date: todayLocalIso() }));
}, []);
```

`todayLocalIso()` builds `yyyy-mm-dd` from `getFullYear/getMonth/getDate` (local),
and `formatLongDate()` renders it as `"Month D, YYYY"` by parsing the ISO parts
directly (no `new Date(iso)`), so a UTC-midnight string never shifts a day
backward in a behind-UTC timezone.

---

## Server-rendered PDF

On a real submit, `POST /api/onboarding/[token]`
([route](../../app/api/onboarding/[token]/route.ts)) renders the signed PDF
**before** the DB write so the storage path is persisted in the same update:

1. Validates the IP fields (`ip_agreement_agreed === true`, name, signature, date)
   among the other required fields.
2. Looks up the submission id from the token, then calls
   `generateIpAssignmentPdf({ name, signatureDataUrl, dateIso })`.
3. Uploads via `uploadIpAssignmentFile(submissionId, pdfBytes)` to the
   **`hr-onboarding-files`** bucket at **`<submission_id>/ip-assignment.pdf`**
   (`upsert: true`).
4. On success, sets `ip_assignment_file_path` + `ip_assignment_file_name`
   (`IP-Assignment-<slug>.pdf`) on the submit payload so `submitHrOnboarding`
   stores them.

**Best-effort:** PDF generation/upload is wrapped in `try/catch`. If it fails,
the raw `ip_agreement_name` / `ip_agreement_signature` / `ip_agreement_date` are
still saved (HR can fall back to the captured signature image), so a PDF hiccup
never blocks the hire from finishing onboarding.

### How the document is drawn

[`src/lib/onboarding/ip-assignment-pdf.ts`](../../src/lib/onboarding/ip-assignment-pdf.ts)
builds the document from scratch with **pdf-lib `^1.17.1`** (no template file is
read at runtime, so it deploys cleanly on Vercel). US-Letter portrait, Helvetica /
Helvetica-Bold, auto-paginating wrapped paragraphs. It bakes in the title + intro
+ all sections, then the acknowledgement, then the PARTICIPANT block (Name text,
embedded signature image scaled onto a rule, formatted Date).

The acknowledgement's "checked box" is **drawn as two vector strokes** — a real
checkmark — because the checkmark glyph isn't in Helvetica's WinAnsi encoding.
It draws a bordered rectangle, then two `page.drawLine` calls with
`LineCapStyle.Round` to form the tick.

Any character outside WinAnsi (codepoints ~32–126 / 160–255) is replaced with
`?` by `sanitize()` so a stray glyph can never crash generation.

---

## HR surfaces

The HR submission-detail modal in
[`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx)
exposes the IP Assignment two ways:

- **A "Summary" block** (`DetailSection title="IP Assignment"`) showing
  Acknowledged?, Signed by, Date, and — when a PDF exists — a filename chip with
  **View** (signed URL, new tab) and **Download** buttons. When
  `ip_assignment_file_path` is null it shows *"PDF not generated"* (the
  best-effort fallback case).
- **A dedicated "IP Assignment" tab** (`DETAIL_TAB_ORDER` =
  `['summary', 'ip_assignment', 'non_solicitation', 'privacy', 'contract']`) that
  re-renders the full agreement copy via `IntellectualPropertyText` plus the
  drawn signature.

The signed URLs come from `GET /api/hr/onboarding-submissions/[id]`
([route](../../app/api/hr/onboarding-submissions/[id]/route.ts)), which (when the
paths exist) returns `ipAssignmentUrl` and `w8benUrl` from
`getIpAssignmentSignedUrl(path, 600)` — a 10-minute signed URL on the private
bucket. The route is gated by `requireElevatedSession`.

> The HR review modal reuses the same agreement React components but is
> **intentionally not** `.onboarding-public` (see [Dark-mode](#dark-mode-theming)),
> so it keeps proper dark-mode rendering.

---

## Preview mode (`/onboarding/preview`)

The same `OnboardingFormPage` renders a no-save **preview** when the route token
is the literal string `"preview"`:

```ts
const isPreview = token === 'preview';
```

Real invite tokens are 32-byte url-safe random strings
(`generateOnboardingToken()` in
[`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts)),
so `"preview"` never collides with a live link. In preview mode the page:

- **Skips the load effect** entirely — no `GET /api/onboarding/...` call; it seeds
  an empty in-memory `link` and sets `loading=false`.
- **Skips per-step validation** in `goNext`, so HR can page through every step.
- **Guards the W-8BEN upload** — `handleFile` shows *"Uploads are disabled in
  preview mode."* instead of hitting the upload route.
- Shows an **amber banner**: *"Preview mode — this is what new hires see. Nothing
  here is saved or submitted."*

### Preview Submit is a dry-run

In preview the footer button is relabeled **"Generate signed PDF"** (vs "Submit"),
and the IP step shows a dashed amber **"Preview test"** panel with its own
generate button. Both call `generateIpPreviewPdf`, which `POST`s to a dedicated
public endpoint and opens the returned PDF in a new tab — **no DB or storage
writes**:

**`POST /api/onboarding/ip-assignment-preview`**
([route](../../app/api/onboarding/ip-assignment-preview/route.ts))

| | |
|---|---|
| Auth | Public — sits under the rate-limited `/api/onboarding/` prefix |
| Body | `{ name, signatureDataUrl, dateIso }` |
| Returns | `application/pdf` (the real `generateIpAssignmentPdf` output), `Cache-Control: no-store` |
| Writes | **None** — pure render |

Because it's under `/api/onboarding/`, the middleware rate limit applies (POST:
5 req / IP / minute — see [`middleware.ts`](../../middleware.ts)).

### HR entry point

The **"Onboarding Paper Work Template"** link card in `HrOnboardingForm` (beside
the "Licenses available" meter) points at the in-app route, **not** a Google Doc:

```ts
const ONBOARDING_PAPERWORK_TEMPLATE_URL = '/onboarding/preview';
```

---

## Dark-mode theming

The public onboarding tree is light-first and theme-pinned, scoped in
[`src/index.css`](../../src/index.css):

- `.onboarding-public` sets `color-scheme: light` and forces
  `input/textarea/select` text to **zinc-900** (`#18181b !important`) and
  placeholders to zinc-400. The rules are **unlayered** so they win over the
  Tailwind utilities layer.
- Under a `.dark` theme, `.dark .onboarding-public p / li` are forced to
  **zinc-700** and `h1–h4` to **zinc-900**, with `:not([class*="text-emerald"])`
  / `text-amber` / `text-yellow` exclusions so accent-colored notes/badges keep
  their hue.

The wizard root carries the `onboarding-public` class; the HR review modal does
**not**, so the same agreement components render correctly in HR's dark theme.

---

## Step transition animation

Step navigation uses a directional **slide + fade** via `motion/react`
(`AnimatePresence mode="wait"`, ~260ms, `ease: [0.22, 1, 0.36, 1]`). A `direction`
state (`+1` forward, `-1` back) drives `STEP_VARIANTS` so the incoming step enters
from the side you're heading toward and the outgoing step leaves the opposite way.
The step card is `overflow-hidden` so a slide never spawns a horizontal
scrollbar. `useReducedMotion()` falls back to a plain cross-fade. This applies to
both `/onboarding/preview` and live `/onboarding/<token>`.

---

## Data model

The agreement is persisted on `hr_onboarding_submissions`. See the row type in
[`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts).

| Column | Type | Notes |
|---|---|---|
| `ip_agreement_agreed` | boolean | `true` once the hire ticks the acknowledgement |
| `ip_agreement_name` | text | Name printed in the PARTICIPANT block |
| `ip_agreement_signature` | text | base64 PNG data URL of the drawn signature |
| `ip_agreement_date` | date | Local day the hire opened/signed the link |
| `ip_assignment_file_path` | text | Storage path of the generated PDF |
| `ip_assignment_file_name` | text | Friendly filename for HR display |

The PDF lives in the private **`hr-onboarding-files`** Storage bucket at
`<submission_id>/ip-assignment.pdf`. The public `GET /api/onboarding/[token]`
returns the IP fields for prefill on a re-opened submitted form but **never** the
file path; HR fetches a signed URL on demand.

---

## Migration (APPLIED)

> **Migration #73 — APPLIED** (verified against production 2026-08-11 by
> `scripts/audit-pending-migrations.mts`; the file now lives under
> `references/sql/alter/`). It was, when written:
> [`references/migrations/add_ip_assignment_to_onboarding.sql`](../../references/migrations/add_ip_assignment_to_onboarding.sql)
> an `ALTER TABLE public.hr_onboarding_submissions ADD COLUMN IF NOT EXISTS` for
> the six columns above.
>
> **Preview mode never needed it** — `/onboarding/preview` and
> `POST /api/onboarding/ip-assignment-preview` touch neither the table nor the
> bucket.

---

## Files

| Path | Role |
|---|---|
| [`src/lib/onboarding/ip-assignment-text.ts`](../../src/lib/onboarding/ip-assignment-text.ts) | Shared copy + `formatLongDate` / `todayLocalIso` |
| [`src/lib/onboarding/ip-assignment-pdf.ts`](../../src/lib/onboarding/ip-assignment-pdf.ts) | pdf-lib renderer (vector checkmark, embedded signature) |
| [`src/components/onboarding/agreement-texts.tsx`](../../src/components/onboarding/agreement-texts.tsx) | `IntellectualPropertyText` + `AGREEMENT_TITLES` |
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Public form, IP step, preview mode, step animation |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Submit: render + store PDF, persist IP fields |
| [`app/api/onboarding/ip-assignment-preview/route.ts`](../../app/api/onboarding/ip-assignment-preview/route.ts) | Public dry-run PDF renderer |
| [`app/api/hr/onboarding-submissions/[id]/route.ts`](../../app/api/hr/onboarding-submissions/[id]/route.ts) | Signed IP/W-8BEN URLs for HR review |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row type, upload + signed-URL helpers |
| [`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx) | HR Summary block + IP Assignment tab + template link |
| [`references/migrations/add_ip_assignment_to_onboarding.sql`](../../references/migrations/add_ip_assignment_to_onboarding.sql) | Migration #73 — **APPLIED** (verified 2026-08-11) |
</content>
</invoke>
