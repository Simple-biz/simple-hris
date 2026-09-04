import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { resolveAnthropicApiKey } from '@/lib/anthropic/api-key';
import { CEO_TOOLS, runCeoTool } from '@/lib/anthropic/ceo-tools';
import { ADMIN_TOOLS, isAdminTool, runAdminTool } from '@/lib/anthropic/admin-tools';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { encodeFrame } from '@/lib/penny/console-stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Chained audit questions can run several thinking+tool turns; 60s risks the
// platform killing the function mid-stream (requires Vercel Pro, like the
// other long routes here).
export const maxDuration = 300;

/**
 * Backing endpoint for the ADMIN dashboard's Penny AI (bubble + tab). Same
 * streaming shape as /api/ceo/chat, but gated strictly to the `admin` role and
 * armed with the operations tool set on top of the payroll tools: audit-log
 * search, diagnostic probes, payroll-wizard runtime state, and per-person
 * rate / transfer / onboarding / bank-change history.
 */

const MODEL = 'claude-opus-5';

/**
 * Opus 5, upgraded from Sonnet 5 on 2026-09-04 (Kane: "upgrade the engine of
 * Penny to Opus"). Admin only — the CEO and employee routes are untouched.
 *
 * What the model change forces:
 * - Thinking is **on by default** on Opus 5 (it was opt-in on Sonnet 5), and
 *   thinking + answer share `max_tokens`. Opus 5 also thinks harder, so the old
 *   12k ceiling would truncate replies that used to fit.
 * - `budget_tokens` and the sampling params (temperature/top_p/top_k) are
 *   REMOVED on this model — sending any of them is a 400. This route sends none;
 *   do not add them.
 * - Assistant prefill is also a 400 here. This route never prefills.
 *
 * Cost: $5/MTok in, $25/MTok out — 2.5× Sonnet 5. The cached system prefix and
 * the short-answer instruction in the prompt are what keep that in hand.
 */
const MAX_TOKENS = 32000;

/**
 * Opus 5's safety classifiers can decline a request outright (HTTP 200,
 * `stop_reason: "refusal"`). Server-side fallback re-runs the same request on a
 * second model inside the same call rather than handing an admin an error.
 * Opus 4.8 is the same tier at the same price, so a rescue costs no more.
 *
 * The beta flag and the ARRAY form of `fallbacks` must match: this SDK
 * (@anthropic-ai/sdk 0.105) types only the array form, whose header is exactly
 * `server-side-fallback-2026-06-01`. Pairing it with the newer scalar
 * (`fallbacks: "default"` + `…-07-01`) is a 400.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const FALLBACK_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  'You are Penny (also called Penny AI), the operations assistant for the',
  "ADMINISTRATORS of Simple's internal HRIS (a payroll, attendance, and",
  'workforce-operations platform). You are speaking with a signed-in system',
  'administrator who is authorized to see all payroll, audit, and employee',
  'data. If asked, your name is Penny.',
  '',
  'Be warm, concise, and direct. Lead with the answer, then any supporting',
  'detail. Default to one to three short sentences. Skip preamble like "Great',
  'question", do not repeat the question back, and do not pad the reply.',
  '',
  '## Formatting (important)',
  '',
  'Replies show as plain text, with ONE exception: GitHub-style pipe tables are',
  'rendered as real tables. So:',
  '- Do NOT use any other Markdown: no asterisks for bold/italics (typing **text**',
  '  just shows literal asterisks), no "#" headings, no backticks, no "*" bullets.',
  '- WHEN the answer is tabular — several pay weeks, audit events, transfers,',
  '  rate changes, or probes — present it as a pipe table: a header row, then a |---|---|',
  '  separator row, then one row per record. Always use leading and trailing',
  '  pipes. Right-align numeric columns by ending the separator cell with a',
  '  colon (e.g. |---:|). Keep columns few and headers short so it fits the',
  '  chat panel.',
  '- For non-tabular answers use short plain sentences. Lead with the takeaway.',
  '',
  '## Live data (tools) — never guess',
  '',
  'You CAN look up real records with your tools. Use them for every factual',
  'question about this HRIS — never invent an event, a date, a rate, or a',
  'status, and never answer a data question from memory.',
  '',
  '- When the user names a person, ALWAYS call find_employee FIRST to get their',
  '  exact work_email. If several people match, ask which one (by department or',
  '  work email) before continuing — do not assume.',
  '- WHO-DID-WHAT questions ("who opened this", "who changed that", "what',
  '  happened yesterday") → search_audit_log. Filter with action_prefix +',
  '  target (the affected person\'s email) and a date range when given.',
  '  action_prefix takes several comma-separated families at once. If a first',
  '  search returns nothing, retry once with a broader filter (e.g. drop the',
  '  prefix, keep the target) before saying there is no record.',
  '- OPEN-ENDED history about ONE person ("what changed for X", "everything on',
  '  X", "what happened to X", "has anything been edited on X") →',
  '  get_change_timeline. It merges bank, rate, name/email/profile, access,',
  '  employment and payroll changes from all four sources into one ordered',
  '  timeline, over the person\'s WHOLE history. Narrow with kind= when the',
  '  question is clearly about one category.',
  '- "Who changed X\'s name / work email / department / address" →',
  '  get_change_timeline with kind="identity", or search_audit_log with',
  '  action_prefix "people.profile". Edits made before 2026-07-31 record only',
  '  WHICH field changed, not its old value — say the field and the actor, and',
  '  never guess what it changed from.',
  '- "Who raised the rate on X" / "rate history of X" → get_rate_history (it',
  '  includes who set each rate). For X\'s CURRENT effective rate use',
  '  get_employee_profile.',
  '- "Who transferred X / when was X transferred" → get_transfer_history.',
  '- "When was X onboarded / who invited X" → get_onboarding_info.',
  '- "Who changed X\'s bank info" → get_bank_change_history. Read the channel',
  '  per row: external_link = the employee themself through the secure link;',
  '  any other channel is a STAFF member acting on their behalf (for example',
  '  payroll_wizard_readiness = an admin typed it into the Payroll Wizard\'s',
  '  Readiness fixer) — name that admin from the matching audit event, and do',
  '  not describe a staff-entered change as the employee updating their own',
  '  details. If the account holder name does not match the employee\'s own',
  '  name, flag it: complete bank details can still be the WRONG person\'s.',
  '- "Who edited the payroll note / who ticked it done / who added that',
  '  adjustment" → get_payroll_notes_history (it resolves each edit to the',
  '  worker, week and amount). For the current open checklist instead use',
  '  get_payroll_wizard_notes.',
  '- Unsure what an action is called, or a search came back empty → ',
  '  list_audit_actions. It reads the live table, so prefer it over any action',
  '  name you remember.',
  '- "Is everything healthy / what\'s happening with the diagnostic probes" →',
  '  run_diagnostics. Summarize the overall status first, then only the probes',
  '  that need attention. The auth-login probe always reports warning by',
  '  design — mention it only if asked.',
  '- "Has the payroll wizard started processing / how far along is payroll" →',
  '  get_payroll_wizard_status. locked=true means processing has started —',
  '  say who started it, when, and the paid-so-far progress.',
  '- Payroll figures (pay, reports, overtime, hours, financials) → the same',
  '  pay tools as the CEO assistant: get_employee_pay, get_payroll_report,',
  '  get_overtime_leaders, get_department_bonuses, get_financial_summary,',
  '  get_hours_uploads, get_uploaded_hours, get_payroll_wizard_notes,',
  '  get_employee_access, get_employee_profile.',
  '- Call tools SILENTLY: do not write any text in the same turn as a tool',
  '  call (no "let me look that up"). Produce text only as your final answer,',
  '  once you have the data.',
  '',
  '## Answering audit questions well',
  '',
  '- Always report WHO (the actor email), WHAT (the action, in plain words),',
  '  and WHEN (date + time, note times are UTC). Quote emails exactly.',
  '- "anonymous" actors are unauthenticated flows (e.g. the public bank-update',
  '  link) — attribute those to the affected employee when the details show it.',
  '- Distinguish an employee acting on themselves from a staff member acting on',
  '  their behalf. The channel and the IP in the event decide it — not the fact',
  '  that the record is about that employee.',
  '- The audit log can be truncated by admins; bank changes also live in a',
  '  dedicated non-clearable history that get_bank_change_history reads.',
  '- Every history tool returns a coverage note saying how far back it searched.',
  '  If it reports a cut-off and you found nothing, say "nothing on record since',
  '  <date>" — never "this never happened". Absence within a window is not',
  '  proof of absence, and an action that started being audited recently has no',
  '  history before then.',
  '- If a tool returns an error or no matching records, say so plainly and',
  '  suggest what to check instead — never fabricate an event.',
].join('\n');

/** Static prompt + a per-request "today is …" section (Asia/Manila is the
 *  company clock), so Penny resolves "today"/"this week" correctly. */
function buildSystemPrompt(now: Date): string {
  const manila = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return [
    SYSTEM_PROMPT,
    '',
    '## Current date and time',
    '',
    `Right now it is ${manila} in Asia/Manila (the company's timezone). Today's`,
    `date is ${isoDate}.`,
    'Resolve every relative date against this: "today", "yesterday", "this',
    'week", "last month". Payroll runs in weekly cycles a week in arrears, so',
    'the newest pay records may lag today by several days — always state the',
    'period a figure actually covers.',
  ].join('\n');
}

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function POST(request: Request) {
  // 1. Authorize — admins only (stricter than the CEO route).
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);
  const email = authz.sessionEmail;

  // 2. Validate the API key is configured before we promise the client a stream.
  const { key: apiKey } = await resolveAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Penny is not configured yet. Add an Anthropic API key in Admin → API tokens (or set ANTHROPIC_API_KEY).' },
      { status: 503 },
    );
  }

  // 3. Parse and sanitize the conversation.
  let body: { messages?: ChatMessage[] };
  try {
    body = (await request.json()) as { messages?: ChatMessage[] };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  let messages: ChatMessage[] = (body.messages ?? [])
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-20); // cap history to keep requests bounded

  // The window must START on a user turn — an alternating transcript sliced to
  // an even count begins with an assistant message, which the API rejects with
  // a 400 (breaking every reply from the ~11th exchange on).
  const firstUser = messages.findIndex((m) => m.role === 'user');
  if (firstUser > 0) messages = messages.slice(firstUser);

  if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
    return NextResponse.json({ error: 'Expected a trailing user message' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  const convo: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const TOOLS = [...CEO_TOOLS, ...ADMIN_TOOLS];
  // Audit questions often chain find_employee → history tool → audit search,
  // so allow a couple more turns than the CEO route.
  const MAX_TURNS = 8;
  const encoder = new TextEncoder();
  const toolsUsed: string[] = [];
  const systemPrompt = buildSystemPrompt(new Date()); // stamp once per request

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answered = false;
      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // The widget went away (tab closed, navigation) — stop burning tokens.
          if (request.signal.aborted) return;

          let turnText = '';
          const claudeStream = client.beta.messages.stream(
            {
              model: MODEL,
              max_tokens: MAX_TOKENS,
              betas: [FALLBACK_BETA],
              fallbacks: [{ model: FALLBACK_MODEL }],
              // Adaptive thinking reasons between tool calls. Effort is `high`
              // (also Opus 5's own default) rather than the old `medium`:
              // reconstructing who-changed-what across four history sources is
              // exactly the intelligence-sensitive work the upgrade is for, and
              // a wrong attribution costs more than a slower answer. Dial to
              // `medium` if chat latency starts to bite.
              thinking: { type: 'adaptive' },
              output_config: { effort: 'high' },
              // Cache the static prefix (tools + system) across the loop's
              // turns and across requests — only the trailing convo varies.
              system: [
                { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
              ],
              tools: TOOLS,
              messages: convo,
            },
            { signal: request.signal },
          );

          claudeStream.on('text', (delta) => {
            turnText += delta;
            controller.enqueue(encoder.encode(delta));
          });

          const msg = await claudeStream.finalMessage();

          if (msg.stop_reason !== 'tool_use') {
            if (turnText.trim().length > 0) answered = true;
            // A refusal means the whole chain declined — the fallback model
            // refused too. Say that plainly instead of letting it fall through
            // to the generic "couldn't finish", which reads as an outage and
            // sends an admin retrying the same question.
            if (msg.stop_reason === 'refusal') {
              const category = msg.stop_details?.category ?? 'unspecified';
              controller.enqueue(
                encoder.encode(
                  turnText.trim().length > 0
                    ? `\n\n[Cut off — the model declined to continue (${category}).]`
                    : `I can't answer that one — the model declined the request (${category}). Try rephrasing, or ask for the underlying records instead.`,
                ),
              );
              answered = true;
              break;
            }
            // Thinking + text share MAX_TOKENS — never let a capped reply pass
            // as complete.
            if (msg.stop_reason === 'max_tokens') {
              controller.enqueue(
                encoder.encode('\n\n[Reply was cut short — ask me to continue for the rest.]'),
              );
              answered = true;
            }
            break;
          }

          // Execute every tool the model asked for, then feed results back.
          convo.push({ role: 'assistant', content: msg.content });
          const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolsUsed.push(block.name);
              // Name the tool to the console BEFORE running it, so its progress
              // readout prints the step actually in flight rather than a
              // plausible one on a timer. Frames are NUL-delimited and stripped
              // by the client hook before any text reaches the transcript, so
              // this is invisible to the CEO and employee surfaces (whose routes
              // emit none) and to every downstream parser.
              controller.enqueue(encoder.encode(encodeFrame({ t: 'tool', name: block.name })));
              const input = (block.input ?? {}) as Record<string, unknown>;
              const result = isAdminTool(block.name)
                ? await runAdminTool(block.name, input)
                : await runCeoTool(block.name, input);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
              });
            }
          }
          convo.push({ role: 'user', content: toolResults });
        }

        // Never leave the widget frozen on "Thinking…".
        if (!answered) {
          controller.enqueue(
            encoder.encode(
              "Sorry — I couldn't finish that just now. Please try rephrasing your question.",
            ),
          );
        }
        controller.close();
      } catch (err) {
        if (request.signal.aborted) return; // client gone — nothing to tell it
        const msg = err instanceof Error ? err.message : String(err);
        // Status is already 200 once streaming starts; surface inline.
        controller.enqueue(encoder.encode(`\n\n[Assistant error: ${msg}]`));
        controller.close();
      } finally {
        // Audit trail: sensitive audit/payroll data passes through here, so
        // every tool-using request leaves a record of who asked.
        if (toolsUsed.length > 0) {
          void insertAuditLog({
            user_name: email,
            user_role: 'admin',
            action: 'admin_assistant.query',
            resource: 'admin_penny_chat',
            details: { tools_used: toolsUsed },
          }).catch(() => {});
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
