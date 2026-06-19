# CEO Assistant

*Added 2026-06. A floating Claude-backed chat widget on the CEO dashboard with read-only payroll tools, an admin-managed API key, and an audit trail.*

A floating `/chatbubble.png` image button pinned to the bottom-right of the CEO dashboard (it swaps to an `X` icon when the panel is open; the `Sparkles` icon shows only in the open panel's header avatar). It talks to Claude (Sonnet) over a streaming endpoint and can pull **real** payroll figures out of `disbursement_records` via three narrow, read-only tools — e.g. *"what was Kane's last pay"* or *"add up the last four weeks of Kane's pay"*. It can also do non-data work (draft announcements, summarize pasted text, think through decisions). Access is gated to `ceo` / `admin`, and every request that touches the tools is audit-logged.

---

## Where it lives

| Layer | File |
|---|---|
| Mount point | `src/components/ceo/CeoApp.tsx` — renders `<CeoChatBubble />` at the end of the CEO shell ("CEO dashboard only") |
| Widget | `src/components/ceo/CeoChatBubble.tsx` |
| Route | `POST /api/ceo/chat` — `app/api/ceo/chat/route.ts` |
| Tools | `src/lib/anthropic/ceo-tools.ts` — `CEO_TOOLS` + `runCeoTool()` |
| Key resolution | `src/lib/anthropic/api-key.ts` — `resolveAnthropicApiKey()` |

The bubble is mounted **only** in the CEO shell at `/ceo`. The shell itself gates entry: `CeoApp` reads `/api/employee-roles?email=` and only renders for `ceo` or `admin` (`src/components/ceo/CeoApp.tsx`). The route re-checks the same gate server-side, so the widget being on the page is not the access control — the route is.

---

## Request flow

```
CeoChatBubble.send(text)
   │  POST /api/ceo/chat  { messages: [{role, content}, …] }
   ▼
route.ts
   1. getServerSession → require email → 401 if not signed in
   2. roles must include 'ceo' or 'admin' → 403 otherwise
   3. resolveAnthropicApiKey() → 503 if no key configured
   4. sanitize history (drop empties, slice content 8000, keep last 20,
      require trailing user message)
   5. tool-use loop (≤ 6 turns), streaming the final text back as
      text/plain; charset=utf-8, Cache-Control: no-store
   ▼
widget reads the body as a ReadableStream, appends each chunk to the
last assistant bubble; shows "Thinking…" until the first text token
```

The response is a **plain UTF-8 text stream** (not SSE / not JSON). The widget reads `res.body.getReader()` and concatenates decoded chunks straight into the message. There is no token framing — Claude's `text` deltas are forwarded verbatim.

### Tool-use loop

The route runs Claude's tool loop server-side (`MAX_TURNS = 6` as a backstop):

1. `client.messages.stream({ model, max_tokens, system, tools: CEO_TOOLS, messages })`.
2. `text` deltas are enqueued to the client as they arrive.
3. On `stop_reason === 'tool_use'`, every `tool_use` block is executed via `runCeoTool(name, input)`, the assistant turn + a `user` turn of `tool_result` blocks are pushed onto `convo`, and the loop continues.
4. Any other `stop_reason` ends the loop. If no text was produced, the route emits a fallback line so the widget never freezes on "Thinking…".

The system prompt instructs the model to **call tools silently** — no "let me look that up" text in the same turn as a tool call — so the widget shows "Thinking…" through the tool turns and only streams the written answer at the end.

### Model + generation config

| Setting | Value |
|---|---|
| `MODEL` | `claude-sonnet-4-6` |
| `max_tokens` | `1500` |
| `thinking` | `{ type: 'disabled' }` (off for low latency) |
| `output_config` | `{ effort: 'medium' }` |
| `system` | inline `SYSTEM_PROMPT` (see below) |
| `runtime` | `nodejs`, `dynamic = 'force-dynamic'` |

---

## Tools (read-only knowledge base)

Defined in `src/lib/anthropic/ceo-tools.ts`. The model **never writes SQL** — each tool is backed by an existing server function or a narrow pre-shaped query. Results are kept small, exact, and labelled with `field_notes` so the model interprets them correctly.

| Tool | Input | What it returns |
|---|---|---|
| `find_employee` | `query` *(string, required)* — name, partial name, or email | `{ match_count, matches[≤8], truncated, note? }`. Each match: `{ name, work_email, department, employee_id }`. The model is told to call this **first** whenever a person is named, and to disambiguate (not guess) on multiple matches. |
| `get_employee_pay` | `work_email` *(string, required)*, `weeks` *(int 1–12, default 1)* | One entry per pay week (most recent first) + a summed `totals`. |
| `get_payroll_report` | `weeks` *(int 1–12, default 4)* | Company-wide weekly totals (paid / outstanding / owed) + a combined `totals`. |

### `find_employee`

Loads the active roster via `getEmployeesForAuthorizedServerRoute()` and filters in memory. Email queries (contain `@`) match `work_email`/`personal_email` exactly; name queries match `name` substring or the work-email local part. Returns at most 8 matches with a `note` that nudges the model to ask the user when 0 or >1 match.

### `get_employee_pay`

- Normalizes the input email (`normEmail`) and **shape-guards** it with `isSafeEmail()` — rejects commas/parens/quotes/whitespace because the value flows into a PostgREST `or()` filter unquoted.
- Expands to an **alias set**: looks up the master record (`getEmployeeMasterRecord`) and adds `work_email`, `personal_email`, `alternate_work_email`, `alternate_work_email_2` (each shape-guarded), since a disbursement row may be keyed on any of the person's addresses.
- Queries `disbursement_records` (service-role client, falls back to server client) with `.or(recipient_email.ilike.<alias>,…)`, ordered by `cycle_period_start` desc, limited to `weeks`.
- Per-week entry: `period_start`, `period_end`, `total_hours`, `regular_hours`, `ot_hours`, `amount_php`, `amount_usd`, `status`, `paid_amount_usd`, `paid_at`.
- `totals`: `weeks_returned`, `sum_amount_php`, `sum_amount_usd`, `sum_paid_usd` (rounded to 2 dp).
- Empty result returns a `note` ("new hire / non-payroll / paid outside this system") rather than a bare empty array.

`field_notes` baked into the result explain the money semantics: `amount_php` / `amount_usd` = computed regular + OT pay (no PAB/Tech bonuses); `paid_amount_usd` = what was actually disbursed (set only when `status = "paid"`, includes bonuses); `status` values `paid` / `pending` / `not_paid` / `threshold` / `problem`.

### `get_payroll_report`

Calls `listDisbursementReports()` and **drops synthesized "urgent" buckets** (MESA / orphanage budget cycles — `cycleId` contains `urgent` or `sourceFile` starts with `urgent`) so they don't muddy a payroll total. Takes the top `weeks` regular cycles. Per-week: `period`, `period_start`, `period_end`, `is_current_cycle`, `paid_count`, `paid_usd`, `paid_php`, `outstanding_count`, `outstanding_usd`, `total_owed_usd`. `totals` sums `total_paid_usd` / `total_paid_php` / `total_outstanding_usd`.

### Adding a tool

Append a definition to `CEO_TOOLS` and a `case` to `runCeoTool()`. Keep results small, exact, and source-labelled; back them with an existing server function rather than ad-hoc SQL.

---

## System prompt

Inline `SYSTEM_PROMPT` in the route. Key behaviours it pins down:

- Persona: assistant for the CEO of Simple, embedded in the HRIS; the CEO is authorized to see all payroll/employee data. Warm, concise, lead with the answer, skip preamble.
- Non-data help: draft announcements, summarize pasted text, explain the dashboard, general questions.
- **Financial discipline**: use tools for any pay question — *never guess, never answer a financial question from memory*. `find_employee` first; disambiguate on multiple matches; `get_employee_pay` for one person; `get_payroll_report` for org-level. Call tools **silently**.
- Reading results: distinguish computed pay vs actually-disbursed; flag `pending` as owed-not-yet-paid; always state which pay week(s) a figure covers; format money with thousands separators + 2 decimals + currency symbol (₱ / $); report tool errors plainly.

---

## Auth, key resolution, and audit

### Auth gate

The route mirrors the **CEO dashboard's own gate**, *not* the "elevated" set used elsewhere. `ceo` is intentionally **not** an elevated role (it can't act on other employees' payroll) but must be able to use its own assistant:

```ts
const session = await getServerSession(authOptions);   // → 401 if no email
const roles = sessionRoles(session);
if (!roles.includes('ceo') && !roles.includes('admin')) // → 403
```

### Key resolution

`resolveAnthropicApiKey()` (`src/lib/anthropic/api-key.ts`) prefers the **admin-managed DB key** over the env var:

1. `app_settings["secret.anthropic_api_key"]` (raw key string, not JSON-wrapped) — settable/rotatable from **Admin → API tokens** without a redeploy.
2. Falls back to `process.env.ANTHROPIC_API_KEY`.
3. `null` → route returns **503** with a message pointing the CEO at Admin → API tokens.

The `secret.` prefix makes `/api/app-settings` treat the key as sensitive (`isSensitiveKey`) and refuse to hand it to non-elevated callers; the full key never reaches the client (see `maskAnthropicKey`). See `docs/features/admin-api-keys.md` for the management UI.

### Audit logging

In the stream's `finally`, if any tool ran, the route writes an `audit_log` entry — sensitive payroll figures pass through, so every data request leaves a record:

```ts
insertAuditLog({
  user_name: email,
  user_role: roles.includes('ceo') ? 'ceo' : 'admin',
  action: 'ceo_assistant.query',
  resource: 'ceo_chat',
  details: { tools_used: toolsUsed },   // e.g. ["find_employee","get_employee_pay"]
});
```

Pure-chat turns that call no tools are **not** audit-logged. The log records *which* tools ran, not the pay figures themselves.

---

## The widget

`CeoChatBubble.tsx` is a self-contained client component:

- Floating `/chatbubble.png` button (amber, `motion/react` icon swap to `X` when open); panel is a `role="dialog"` card anchored bottom-right.
- Empty state shows three suggestion chips: *Draft a company-wide announcement*, *Summarize this for me*, *Help me think through a decision* — none are payroll prompts (those are typed freely).
- `Enter` sends, `Shift+Enter` newlines; `Escape` closes; autofocus on open; transcript auto-scrolls.
- **Streaming render**: on send, an empty assistant message is appended; chunks from the stream are concatenated into it. While `busy` and the last assistant message is still empty, a spinning "Thinking…" placeholder shows.
- History is the full local transcript (`messages`), sent each request; the server independently caps it to the last 20 turns and 8000 chars/message.
- Errors: non-OK responses surface the JSON `error` string in the bubble; mid-stream failures from the route arrive inline as `[Assistant error: …]`.
- Footer disclaimer: *"Assistant can make mistakes. Verify important details."*

The transcript is **ephemeral** — held in component state only, lost on unmount/reload. There is no server-side conversation store.

---

## Notes & boundaries

- **Read-only.** No tool writes to the database; the model cannot run arbitrary SQL.
- **No migration.** The feature reuses existing tables (`disbursement_records`, `app_settings`, `audit_log`) — nothing new to apply.
- **Data scope.** `get_employee_pay` covers regular payroll disbursements only; bonuses surface only inside `paid_amount_usd` for paid weeks. `get_payroll_report` excludes MESA/orphanage urgent buckets by design.
- **Currency.** Figures carry both PHP and USD where present; the model is told to format with the right symbol. Disbursement amounts are stored per the payroll currency model (see `docs/features/usd-bonuses-and-dispatch.md`).
