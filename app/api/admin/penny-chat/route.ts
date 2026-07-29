import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { resolveAnthropicApiKey } from '@/lib/anthropic/api-key';
import { CEO_TOOLS, runCeoTool } from '@/lib/anthropic/ceo-tools';
import { ADMIN_TOOLS, isAdminTool, runAdminTool } from '@/lib/anthropic/admin-tools';
import { insertAuditLog } from '@/lib/supabase/audit-log';

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

const MODEL = 'claude-sonnet-5';

// Sonnet 5 runs adaptive thinking by default and max_tokens caps thinking +
// answer together, so leave more headroom than the CEO route's 8k.
const MAX_TOKENS = 12000;

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
  '  target (the affected person\'s email) and a date range when given. If a',
  '  first search returns nothing, retry once with a broader filter (e.g. drop',
  '  the prefix, keep the target) before saying there is no record.',
  '- "Who raised the rate on X" / "rate history of X" → get_rate_history (it',
  '  includes who set each rate). For X\'s CURRENT effective rate use',
  '  get_employee_profile.',
  '- "Who transferred X / when was X transferred" → get_transfer_history.',
  '- "When was X onboarded / who invited X" → get_onboarding_info.',
  '- "Who changed X\'s bank info" → get_bank_change_history. Self-service',
  '  changes through the update link were made by the employee themself —',
  '  say that plainly; admin-side edits show the acting admin.',
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
  '- The audit log can be truncated by admins; bank changes also live in a',
  '  dedicated non-clearable history that get_bank_change_history reads.',
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

  const convo: Anthropic.MessageParam[] = messages.map((m) => ({
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
          const claudeStream = client.messages.stream(
            {
              model: MODEL,
              max_tokens: MAX_TOKENS,
              // Sonnet 5: adaptive thinking (its default) reasons between tool
              // calls; medium effort keeps latency chat-friendly.
              thinking: { type: 'adaptive' },
              output_config: { effort: 'medium' },
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
            // Thinking + text share MAX_TOKENS on Sonnet 5 — never let a
            // capped reply pass as complete.
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
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolsUsed.push(block.name);
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
