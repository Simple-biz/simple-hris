import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { resolveAnthropicApiKey } from '@/lib/anthropic/api-key';
import { CEO_TOOLS, runCeoTool } from '@/lib/anthropic/ceo-tools';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Backing endpoint for the CEO dashboard's floating chat assistant.
 *
 * Auth mirrors the CEO dashboard's own gate (`ceo` or `admin`) rather than the
 * "elevated" set used elsewhere — `ceo` is intentionally NOT an elevated role
 * (it can't act on other employees' payroll), but it must be able to use its
 * own assistant. The response is a plain UTF-8 text stream the widget reads
 * chunk-by-chunk.
 */

const MODEL = 'claude-sonnet-4-6';

// Keep replies focused and snappy for a small chat widget. Streaming keeps the
// connection alive regardless of length; thinking is off for low latency.
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = [
  'You are the assistant for the CEO of Simple, embedded as a chat widget inside',
  "the company's internal HRIS (a payroll, attendance, and workforce-operations",
  'platform). You speak with the CEO directly, who is authorized to see all',
  'payroll and employee data.',
  '',
  'Be warm, concise, and direct. Lead with the answer, then any supporting',
  'detail. Default to one to three short sentences. Skip preamble like "Great',
  'question" or "As an AI", do not repeat the question back, and do not pad the',
  'reply — say what is needed and stop.',
  '',
  '## Formatting (important)',
  '',
  'Replies show as plain text, with ONE exception: GitHub-style pipe tables are',
  'rendered as real tables. So:',
  '- Do NOT use any other Markdown: no asterisks for bold/italics (typing **text**',
  '  just shows literal asterisks), no "#" headings, no backticks, no "*" bullets.',
  '- WHEN the answer is tabular — several pay weeks, or a list of people with',
  '  figures — present it as a pipe table: a header row, then a |---|---|',
  '  separator row, then one row per record. Always use leading and trailing',
  '  pipes. Right-align numeric columns by ending the separator cell with a colon',
  '  (e.g. |---:|). Keep columns few and headers short (e.g. Week, Hours, Pay,',
  '  Status) so it fits a narrow chat panel; you can put PHP and USD in one cell.',
  '- For non-tabular answers use short plain sentences (one item per line if you',
  '  must list). Lead with the takeaway. Keep it tight; never a wall of text.',
  '',
  'You can help the CEO think through decisions, draft announcements and',
  'messages, summarize or restructure text they paste in, explain how parts of',
  'the dashboard work, and answer general questions.',
  '',
  '## Live financial data (tools)',
  '',
  'You CAN look up real payroll figures using your tools. Use them whenever the',
  'CEO asks about a person\'s pay or company payroll — never guess or invent a',
  'number, and never answer a financial question from memory.',
  '',
  '- When the user names a person, ALWAYS call find_employee FIRST to get their',
  '  exact work_email. If it returns several people, ask which one (by department',
  '  or work email) before looking up pay — do not assume.',
  '- Use get_employee_pay for one person\'s pay ("last pay" = weeks:1; "last four',
  '  weeks" = weeks:4). The tool returns a per-week breakdown AND a summed total,',
  '  so for "add up" questions, report the total and show the weeks behind it.',
  '- Use get_payroll_report for company-wide / "pull the report" questions.',
  '- Call tools SILENTLY: do not write any text in the same turn as a tool',
  '  call (no "let me look that up"). Produce text only as your final answer,',
  '  once you have the data.',
  '',
  'Reading results: a week\'s amount_php / amount_usd is the computed regular+OT',
  'pay (no bonuses); paid_amount_usd is what was actually disbursed (only when',
  'status is "paid"). If status is "pending" the person is owed but not yet paid —',
  'say so. Always state which pay week(s) a figure covers (e.g. "the week of',
  'Apr 12–18"). Format money with thousands separators and 2 decimals, with the',
  'currency symbol (₱ for PHP, $ for USD). If a tool returns an error or no',
  'records, tell the CEO plainly rather than making something up.',
].join('\n');

type ChatMessage = { role: 'user' | 'assistant'; content: string };

function sessionRoles(session: unknown): string[] {
  const user = (session as { user?: { roles?: string[] } } | null)?.user;
  return Array.isArray(user?.roles) ? user!.roles! : [];
}

export async function POST(request: Request) {
  // 1. Authorize — must be a signed-in CEO or admin (same gate as /ceo).
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string } | undefined)?.email;
  if (!email) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const roles = sessionRoles(session);
  if (!roles.includes('ceo') && !roles.includes('admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 2. Validate the API key is configured before we promise the client a stream.
  // Prefers the admin-managed key (Admin → API tokens), falls back to the env var.
  const { key: apiKey } = await resolveAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'The assistant is not configured yet. Add an Anthropic API key in Admin → API tokens (or set ANTHROPIC_API_KEY).' },
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

  const messages: ChatMessage[] = (body.messages ?? [])
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-20); // cap history to keep requests bounded

  if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
    return NextResponse.json({ error: 'Expected a trailing user message' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  // 4. Run a tool-use loop and stream the final answer back as plain text.
  //    The model may call data tools (find_employee, get_employee_pay, …) for a
  //    turn or two with no visible output — the widget shows "Thinking…" until
  //    the first text token arrives — then stream its written answer.
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const MAX_TURNS = 6; // safety backstop against a tool-call loop
  const encoder = new TextEncoder();
  const toolsUsed: string[] = [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answered = false;
      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          let turnText = '';
          const claudeStream = client.messages.stream({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            thinking: { type: 'disabled' },
            output_config: { effort: 'medium' },
            system: SYSTEM_PROMPT,
            tools: CEO_TOOLS,
            messages: convo,
          });

          claudeStream.on('text', (delta) => {
            turnText += delta;
            controller.enqueue(encoder.encode(delta));
          });

          const msg = await claudeStream.finalMessage();

          if (msg.stop_reason !== 'tool_use') {
            // Final turn — model has answered (or, rarely, produced nothing).
            if (turnText.trim().length > 0) answered = true;
            break;
          }

          // Execute every tool the model asked for, then feed results back.
          convo.push({ role: 'assistant', content: msg.content });
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolsUsed.push(block.name);
              const result = await runCeoTool(
                block.name,
                (block.input ?? {}) as Record<string, unknown>,
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
              });
            }
          }
          convo.push({ role: 'user', content: toolResults });
        }

        // Never leave the widget frozen on "Thinking…": if the loop hit its
        // turn cap mid-tool-chain, or the final turn produced no text, say so.
        if (!answered) {
          controller.enqueue(
            encoder.encode(
              "Sorry — I couldn't finish that just now. Please try rephrasing your question.",
            ),
          );
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Status is already 200 by the time we stream; surface the failure
        // inline so the widget can show it to the user.
        controller.enqueue(encoder.encode(`\n\n[Assistant error: ${msg}]`));
        controller.close();
      } finally {
        // Audit trail: who queried financial data and which tools ran. Sensitive
        // payroll figures pass through here, so every request leaves a record.
        if (toolsUsed.length > 0) {
          void insertAuditLog({
            user_name: email,
            user_role: roles.includes('ceo') ? 'ceo' : 'admin',
            action: 'ceo_assistant.query',
            resource: 'ceo_chat',
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
