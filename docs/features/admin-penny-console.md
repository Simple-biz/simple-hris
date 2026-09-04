# Admin Penny console

The Admin dashboard's Penny AI, restyled as an operator's console (Kane,
2026-09-04) and given a side channel so its progress readout reports real work.

Everything here is scoped to **Admin**. The CEO Penny tab, the CEO bubble and
the employee bubble are unchanged — `ceo-assistant.md` and
`employee-penny-ai.md` still govern those.

## What shipped

| Piece | File |
|---|---|
| The console surface (replaces `BizAiTab` on Admin) | `src/components/admin/AdminPennyConsole.tsx` |
| Activity-frame wire format + parser | `src/lib/penny/console-stream.ts` |
| One progress phrase per tool, boot banner, idle line | `src/lib/penny/console-phases.ts` |
| Frame emission | `app/api/admin/penny-chat/route.ts` |
| Frame stripping + `activity` state | `src/components/ceo/use-ceo-chat.ts` |
| `tone` prop (`penny` \| `console`) | `ceo-chat-message.tsx`, `CeoChatBubble.tsx` |
| Orange Penny mark in the nav | `src/components/admin/AdminSidebar.tsx` |
| Engine: `claude-opus-5` + refusal fallback | `app/api/admin/penny-chat/route.ts` |
| `/clear` command matcher | `src/lib/penny/console-commands.ts` |

Tests: `src/lib/penny/console-stream.test.ts` (12), `console-phases.test.ts` (10),
`console-commands.test.ts` (7).

## The console never claims work that isn't happening

This is the reason the feature has a backend half at all.

Penny's chat routes stream **`text/plain` token deltas** and nothing else, so
until now the client could not know which tool the model was running. A progress
readout built on that blindness can only guess — and People → Offboarded, whose
console treatment this borrows, exists precisely because its phases *do* mirror
what its route does.

So `/api/admin/penny-chat` now interleaves **activity frames** with the text:

```
<NUL> {"t":"tool","name":"search_audit_log"} <NUL>
```

- **NUL is the delimiter because the model cannot emit one.** It is not legal
  inside a JSON string, so no reply can forge a frame or be mistaken for one.
  Source files spell it `'\u0000'` — never a literal control byte, which
  corrupts the file and reads as a binary blob to `grep`.
- The frame is enqueued **before** the tool runs, so the line on screen is the
  step in flight.
- `splitFrames()` lifts frames out **in `useCeoChat`, upstream of the
  transcript** — therefore upstream of the biz-report fence parser, the
  pipe-table pass and the Markdown pass. No downstream parser ever sees one.
- A frame split across two network chunks is **held**, never half-parsed; the
  hook carries `rest` in front of the next chunk. A test walks *every* split
  point of a framed stream and asserts the text and the frame both survive.
- An unterminated frame past `MAX_FRAME_CHARS` (512) is **discarded, not
  flushed** — NUL-laden junk must never be appended to an answer.
- Unknown frame types are ignored, so a newer route cannot break an older client.

**Routes that emit no frames get their text back byte-for-byte**, which is what
keeps the CEO and employee surfaces identical. That is asserted directly: a
frameless body is compared under every possible chunking.

`console-phases.ts` maps each tool to the work it really does. Its test
source-scans `CEO_TOOLS` and `ADMIN_TOOLS` (both files are `server-only`, so
they cannot be imported in a node test — the employee tool guards solved this
the same way) and asserts:

- every one of the 21 tools has a phrase — an unmapped tool would print a raw
  `get_bank_change_history` to an admin mid-answer;
- no phrase is the fallback, compared against the exact fallback **output**, not
  its prefix ("Running the diagnostic probes" is correct copy for
  `run_diagnostics` and shares the fallback's first word);
- no phrase for a tool that no longer exists;
- phrases carry no trailing punctuation — the view owns the ellipsis, so a
  running step and a finished step typeset differently from one string.

A **negative control** runs first and refuses to conclude anything unless the
scan actually found both tool sets. A scan that silently matched nothing would
report full coverage of an empty set.

The one phase the client asserts on its own is **"Writing the answer"** — it can
see the text arriving, so it may say so. Everything else comes from the server.

## The visual world

Pinned by Kane: terminal register, black + orange, centered, animated.

- **Always dark.** The console ignores the app's light/dark switch — a terminal
  is a terminal, the way an embedded editor is. The surrounding admin chrome
  (sidebar, header, footer) stays themed. This is a deliberate exception to
  PRODUCT.md's both-themes rule, matching the Offboarded carve-out.
- **Centered terminal window:** `mx-auto max-w-[1080px]`, margins on all four
  sides, its own title bar, transcript, activity readout and prompt line.
- **Palette** (literal hex — the ground is warmer than zinc and the accent sits
  at one value). Contrast on the `#101014` panel: body `#e8ded2` ≈ 14:1, dim
  `#a89a8d` ≈ 7:1, faint `#8a7f73` ≈ 4.9:1, accent `#ff7a1a` ≈ 7.2:1 — AA or
  better. Secondary text is **tinted from the accent's hue, never gray**.
- **Mono for chrome and data; sans for prose.** Following Offboarded. Mono
  paragraphs at 13px read worse, and mono-as-costume is not the point — the
  table cells, emails, IDs and figures are where it earns its place.
- **The caret blinks on a square wave** (`step-end`), because a real caret snaps
  between states; `animate-pulse` is a fade wearing a caret's clothes. The
  composer hides the **native** caret while the field is empty and stands a
  block caret in its place, then restores an orange native caret once there is
  text to edit — so it idles like a terminal without ever showing two carets.
- **Browser surfaces are themed**, scoped under `.penny-console`: `::selection`,
  the caret colour, and the scrollbar (thin, warm track, orange on hover).
- **Boot plays once per browser session** (`sessionStorage`, key
  `penny.console.booted`, read during the first render so an already-booted
  session never paints a frame of the animated state). The Admin shell remounts
  every tab, and replaying a typewriter on each tab hop is an irritation, not a
  flourish. The whole sequence is ~600ms; banner lines land while the headline
  types, which is what a real boot log does.
- **Both boot lines are claims** — read-only, and audited — so a test asserts
  the banner still says them *and* that the route still writes
  `admin_assistant.query`. If Penny ever gains a write tool, the banner is lying.
- Every animation has a reduced-motion fallback; the scan line is absent under
  it, because the readout carries the state in text.

The user's turn renders as a **command** (`$` prompt, mono, accent) rather than
a chat bubble. The finished step log collapses to one dim expandable line — it
is evidence for the answer above it, so it stays reachable rather than vanishing.

## Scope of the `tone` prop

`penny` holds the original violet/fuchsia class strings **verbatim**, so adding
the prop changed nothing on the surfaces that don't pass it. Admin passes
`console` to the tab, the bubble, `AssistantContent` and `MessageFeedback`.

The metered-quota styling deliberately has **no console variant**: only the
employee surface is metered (`metered = !!quotaEndpoint && …`), and Admin passes
no `quotaEndpoint`, so those branches never render here.

The closed bubble button needed **no change** — its halo was already orange.


## Engine

`claude-opus-5` since 2026-09-04 (was `claude-sonnet-5`). Admin only.

- **Thinking is on by default** on Opus 5 and shares `max_tokens` with the
  answer, so `MAX_TOKENS` is 32000 — the old 12k truncated replies that used to
  fit. `output_config.effort` is `high` (Opus 5's own default), up from
  `medium`: attributing who-changed-what across four history sources is the
  work the upgrade is for. Drop to `medium` if chat latency bites.
- **`budget_tokens`, `temperature`, `top_p`, `top_k` and assistant prefill are
  all 400s on this model.** The route sends none — do not add them.
- The route uses **`client.beta.messages.stream`** so it can pass
  `fallbacks: [{ model: 'claude-opus-4-8' }]` with beta
  `server-side-fallback-2026-06-01`: on a policy decline the API re-runs the
  request on the fallback model inside the same call. **The beta flag and the
  `fallbacks` form must match** — this SDK types only the array form; the scalar
  `fallbacks: "default"` needs the `-2026-07-01` flag and mixing them is a 400.
- `stop_reason: 'refusal'` is handled explicitly, because a refusal on the final
  response means the whole chain declined and the generic "couldn't finish"
  reads as an outage.
- Cost: **$5 / $25 per MTok**, 2.5× Sonnet 5. The cached system prefix and the
  "one to three short sentences" instruction are what keep that in hand.


## CRT power-on (2026-09-04)

Kane: "an entrance animation like a TV turning on from the 80s." It plays on
**every** entry to the tab — the Admin shell unmounts each tab, so mounting *is*
switching to it. That differs from the boot banner on purpose: re-reading four
lines of text is tedious, a 700ms hardware flick is a transition.

Split in two halves, because **a dark panel cannot fake light**:
`filter: brightness(3)` on a #101014 surface multiplies black by three and
returns black, so the bloom has to be its own emissive layer.

- **Geometry** (the `motion.section`, transforms only → stays on the compositor
  and leaves no residual `filter` behind): the raster is collapsed to
  `scaleY: 0.006`, HOLDS for a beat, then opens vertically while a slight
  horizontal overscan (`scaleX: 1.035 → 1`) settles inward. Content squashes
  with it, which is what a real tube does — the picture *is* the raster.
- **Light** (`CrtPowerOn`, an overlay that **unmounts when it finishes**, so
  four stacked layers and a `backdrop-blur` cost nothing afterwards). Four real
  mechanisms in the order they happen: the **raster line** (before vertical
  deflection, the whole picture is one bright streak across the middle — the
  signature everyone recognises), the **phosphor bloom** as the high voltage
  overshoots, **scanlines** thinning as the beam settles, and **one roll-bar
  pass** before sync locks.
- The overlay sits **outside** the scaled section, over the same rect, so the
  raster line stays crisp instead of being squashed with the content. That is
  why the panel's sizing moved to a wrapper `div`.
- **The bloom peaks well below a white-out and rises and falls once.** A
  repeating flash at panel size would be a photosensitivity hazard. Under
  `prefers-reduced-motion` the overlay never mounts and the panel appears at
  full scale.

## `/clear`

Typing `/clear` at the prompt wipes the screen instead of asking Penny
(`resolveConsoleCommand` → `clearChat()`, which also drops the activity log).

**The failure this guards is swallowing a real question.** A wasted model call
is cheap; a question that silently does nothing is not — the admin retypes it,
or believes it was answered. So the matcher is whole-input, exact,
case-insensitive, slash-prefixed only, and the test pins the near-misses that
must still reach Penny: bare `clear` (a plausible thing to ask about a note or
a dispute), `/clear the dispute for franm@`, `/clearx`, `/clear-all`. An
unknown slash word is **passed through, not rejected** — refusing it would mean
guessing which of an admin's phrasings were meant as commands.

Both the Enter key and the send button route through one `submit()`, so a
command can never work in one and reach the model from the other. The hint row
under the prompt is the command's **only** affordance, so a test asserts every
command it advertises actually resolves.

### The erase

`/clear` runs a 300ms erase before the screen is swapped, and it is built to
read as a *different event* from the power-on rather than "the animation this
screen does": the power-on **opens from the centre** over 700ms, the erase
**sweeps top to bottom** in 300ms.

- **The transcript is swapped when the head reaches the bottom, not when the
  command is typed.** So the content the head passes over is the content being
  removed — otherwise it is a bright line travelling across an already-blank
  screen.
- The head rides the **exact boundary of the transcript's clip** (`clipPath`
  `inset(0%…)` → `inset(100%…)`, both linear, both `CLEAR_MS`). The text does
  not fade out from under a decorative line; the line is what removes it.
- Behind it is a short warm trail — the one physically true thing about clearing
  a CRT: the phosphors do not switch off, they decay, so just-erased rows glow
  briefly after the beam has moved on. It is a fixed-height element scaled from
  its top edge, not an animated `height`: it is the large element here, so it
  stays on the compositor. The 2px head animates `top` (a percentage `y` would
  resolve against the head's own height and move it 2px); it is absolutely
  positioned, so nothing reflows.
- **A second `/clear`, or a question, is ignored mid-sweep** — either would swap
  content out from under the head.
- The prompt empties **immediately**, not at the end: the erase is about the
  transcript, and a command still sitting at a prompt being wiped looks stuck.
- **The boot banner re-types afterwards** (`bootEpoch` bypasses the
  once-per-session flag). A clear is an explicit request for a fresh screen, so
  unlike a tab hop it has earned the boot sequence — and a blank screen that
  instantly repopulates with a full banner is a pop, not a clear.
- Under reduced motion there is no sweep: the effect finishes immediately and
  the overlay never mounts.
- **The activity readout is suppressed on an empty transcript.** `clearChat`
  does not abort an in-flight request, so `busy` can still be true right after a
  clear, and a step log for a conversation that no longer exists would report
  work whose result you cannot see.

## The command rail

A standing reference down the left of the panel (Kane: "add the commands at the
left side so we can remember the functions") — the commands are remembered by
being visible, not by being memorised.

- Driven by **`CONSOLE_COMMAND_HINTS`**, the same list whose test asserts every
  row resolves to a real command. One list, so the rail cannot advertise
  something the matcher will not answer.
- **Clicking a row inserts the command into the prompt and focuses it — it does
  not run it.** Uniform for every command (one taking an argument needs you to
  finish typing), and a stray click can never wipe a transcript you were
  reading. The Enter afterwards is the thing that acts.
- The rail sits **below the title bar**, so the title bar still spans the full
  window the way a window title bar should.
- **Hidden below `lg`**, where 188px of rail comes straight out of the
  transcript's measure. The compact hint under the prompt is the affordance
  there, and is `lg:hidden` in turn — exactly one affordance at every width, and
  none that disappears at a breakpoint.
- The **Keys** block lists bindings the surface actually implements. "What can I
  press here" is the same question as "what can I type", so they live together.

## Gotchas

- `BizAiTab` is still the CEO's tab. Do not "unify" it with the console; the
  split is the feature.
- The Admin nav's Penny icon uses a darker orange in light mode
  (`#e35c00`, ≈3.6:1) so a 15px glyph clears the non-text contrast floor;
  `#ff7a1a` is only used on dark.
- Adding a tool to `ADMIN_TOOLS` or `CEO_TOOLS` **requires** a phrase in
  `TOOL_PHASES` — the test fails otherwise, by design.
- Adding a console command means adding its `CONSOLE_COMMAND_HINTS` row: a
  command with no hint row is invisible, and a hint row for a command that does
  not resolve fails the test.
