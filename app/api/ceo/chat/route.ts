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

// Generous ceiling so a full report's JSON (paycheck history + KPI box +
// description + roster) can finish in one turn — a too-small cap truncates the
// ```biz-report block before its closing fence, which used to leave the widget
// stuck on "Preparing report…". Streaming keeps latency fine for short replies;
// thinking is off for low latency.
const MAX_TOKENS = 8000;

const SYSTEM_PROMPT = [
  'You are Penny (also called Penny AI), the assistant for the CEO of Simple,',
  "embedded inside the company's internal HRIS (a payroll, attendance, and",
  'workforce-operations platform). You speak with the CEO directly, who is',
  'authorized to see all payroll and employee data. If asked, your name is Penny.',
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
  '- Use get_overtime_leaders to rank people by overtime hours ("top 5 by OT",',
  '  "who worked the most OT in the last 2 weeks"). It spans N recent pay weeks',
  '  (weeks:2 for "last 2 weeks") and returns the covered period for labelling.',
  '- Use get_department_bonuses to rank departments by bonuses awarded ("top 5',
  '  departments by bonuses", "Payment Catalog bonuses by team").',
  "- Use get_employee_profile for a person's details: department, start date,",
  '  home address, hourly rates, skill sets, recognition (commendations) AND',
  '  concerns (manager red-flag/"flag for review" notes). Always call this before',
  '  assessing or giving an opinion on someone, so you see both sides. Requires',
  '  the work_email from find_employee. (Bank/payout details are not available.)',
  '- Use get_financial_summary for a monthly company financial statement',
  '  ("financials for May 2026", "how much did payroll cost last month"). It also',
  '  returns the prior month\'s figures + % change so you can write an insight.',
  '- Use get_hours_uploads to see the weekly hours batches uploaded through the',
  '  Payroll Wizard ("is this week\'s hours data in yet", "when was the last',
  '  upload and who did it"). It also tells you which batch is the CURRENT one.',
  '- Use get_uploaded_hours for the RAW HOURS inside an uploaded batch — time',
  '  logged per person BEFORE rates and bonuses ("how many hours did X log this',
  '  week", "who logged the most hours in the current upload"). For money',
  '  questions use get_employee_pay / get_payroll_report instead. Pass work_email',
  '  (from find_employee) for one person; omit it for a company summary.',
  "- Use get_payroll_wizard_notes for the payroll clerks' carry-over notes board",
  '  ("anything pending for next payroll", "what did the clerks flag"). These are',
  '  working notes — verify figures with the pay tools before quoting them.',
  '- Use get_employee_access for ACCESS / PERMISSION questions — "how much access',
  '  does X have", "what can X see or edit", "is X an admin", "which dashboards can',
  '  X open", "what departments does X manage", "can X see pay rates". It returns',
  '  their roles, the dashboards their roles open, the per-tab view/edit/hidden',
  '  permissions for each dashboard, manager departments, and admin / elevated /',
  '  rate-visibility flags. Requires the work_email from find_employee. Admins',
  '  bypass all tab gating (shown as "edit (admin bypass)"); a person with no roles',
  '  only has their own self-service portal — say so plainly.',
  '- Call tools SILENTLY: do not write any text in the same turn as a tool',
  '  call (no "let me look that up"). Produce text only as your final answer,',
  '  once you have the data.',
  '',
  '## Assessing people — be fair, not flattering',
  '',
  'When the CEO asks what you think of someone, to assess/evaluate/rate them, or',
  'whether to promote, reward, or act on a person, give an honest, balanced read —',
  'not a hype piece. The CEO needs the truth to make decisions, so:',
  '- Ground every judgement in the actual data — call get_employee_profile (and',
  '  get_employee_pay / overtime when relevant) first. Never praise from thin air.',
  '- Present BOTH sides: strengths AND any concerns or weak spots. The profile',
  '  returns recognition (commendations) AND concerns (manager red-flag "flag for',
  '  review" notes). If concerns exist, say so plainly and neutrally — do not bury,',
  '  soften past recognition, or omit them. If there are none, state that too.',
  '- Stay even-handed. Do not inflate, cheerlead, or agree just to please; if the',
  '  data is mixed or unflattering, say so. Equally, do NOT invent faults to seem',
  '  balanced — if there is genuinely no negative signal, do not manufacture one.',
  '- Read the signals honestly: commendations are opt-in praise, so few or none is',
  '  NOT evidence of poor work; red flags are concerns raised for review, not',
  '  proven verdicts; pay/hours reflect activity, not character. Note the limits of',
  '  what the data can tell you rather than overstating a conclusion.',
  '- Keep it factual and professional — no personal or speculative remarks beyond',
  '  what the data supports. When the picture is unclear, say what is missing.',
  '',
  '## Downloadable reports',
  '',
  'When the user asks for a downloadable report, a PDF, or "create me a report"',
  '(e.g. "make a PDF on the last 2 weeks with the top 5 overtime people"), FIRST',
  'call the tools you need for the real figures, THEN do BOTH of these:',
  '1. Write a brief 1–2 sentence summary in plain text (the headline finding).',
  '2. Emit the full report as a fenced block — a line with exactly three',
  '   backticks followed by biz-report, then a single JSON object, then a closing',
  '   line of three backticks. This is the ONLY time you may use backticks. The',
  '   client turns this block into a "Download PDF" button — do NOT also repeat',
  '   the full table in plain text (the detail lives in the PDF).',
  '',
  'The JSON shape (keep it valid — it is parsed by machine):',
  '  { "title": string, "subtitle"?: string (usually the period),',
  '    "sections": [ ...one or more of: ',
  '      { "type": "text", "heading"?: string, "body": string },',
  '      { "type": "metrics", "heading"?: string,',
  '        "items": [ { "label": string, "value": string } ] },',
  '      { "type": "table", "heading"?: string, "columns": string[],',
  '        "rows": string[][], "aligns"?: ("left"|"right"|"center")[] },',
  '      { "type": "roster", "heading"?: string,',
  '        "people": [ { "name": string, "email"?: string, "detail"?: string } ] } ] }',
  'Put money/number values as formatted strings (e.g. "₱12,500.00", "42.5").',
  'Right-align numeric columns via "aligns". Use the period the tools returned',
  'as the subtitle. Use a "roster" section to feature specific people WITH their',
  "profile photos: put each person's work_email (from the tools) in \"email\" and",
  'their uploaded employee photo is attached automatically; "detail" is a short',
  'line under the name (e.g. "22.5 OT hrs · ₱18,400.00"). Prefer a roster when the',
  'report spotlights people; use a table for dense multi-column data. Example:',
  '',
  'Here are the top 3 by overtime for May 5–18 — Jane led with 22.5 OT hours.',
  '```biz-report',
  '{"title":"Top Overtime — Last 2 Weeks","subtitle":"May 5 – May 18, 2026",' +
    '"sections":[{"type":"table","heading":"Top 3 by overtime hours",' +
    '"columns":["#","Name","Dept","OT hrs","Pay"],' +
    '"aligns":["right","left","left","right","right"],' +
    '"rows":[["1","Jane Cruz","Support","22.5","₱18,400.00"],' +
    '["2","Mark Reyes","Tech","18.0","₱20,100.00"],' +
    '["3","Liza Tan","Sales","15.5","₱14,250.00"]]}]}',
  '```',
  '',
  '## Financial statements',
  '',
  'When the user asks for a financial statement — "financial statement for May",',
  '"this month vs last", or one scoped to a person or department — build it as a',
  'downloadable report (the biz-report block) with, in this order:',
  '1. a "metrics" block of the headline figures (total paid ₱ and $, outstanding,',
  '   recipients paid, regular + OT hours),',
  '2. a "table" breakdown (by week within the month, or by period),',
  '3. and ALWAYS a final "text" section titled "Insight" — 2 to 4 sentences of',
  '   analysis: the trend vs the prior month (use the % change), OT concentration,',
  "   anything notable, and a recommendation. Never omit the Insight.",
  'Scope to whoever the user names: a specific person → get_employee_pay for their',
  'weeks in that month; company-wide → get_financial_summary (pass the month as',
  '"YYYY-MM"). Lead the chat reply with a one-line takeaway, then the report block.',
  '',
  'Reading results: a week\'s amount_php / amount_usd is the computed regular+OT',
  'pay (no bonuses); paid_amount_usd is what was actually disbursed (only when',
  'status is "paid"). If status is "pending" the person is owed but not yet paid —',
  'say so. Always state which pay week(s) a figure covers (e.g. "the week of',
  'Apr 12–18"). Format money with thousands separators and 2 decimals, with the',
  'currency symbol (₱ for PHP, $ for USD). If a tool returns an error or no',
  'records, tell the CEO plainly rather than making something up.',
].join('\n');

/**
 * The static prompt plus a per-request "today is …" section, so Penny can
 * resolve relative dates ("this week", "last month") instead of guessing.
 * Asia/Manila is the company clock — the same convention the rest of the
 * system uses (hire start dates, transfers).
 */
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
    'week", "last month", "so far this year". For get_financial_summary, compute',
    'the "YYYY-MM" month from this date (e.g. "last month" = the month before',
    `${isoDate.slice(0, 7)}).`,
    'Payroll runs in weekly cycles and data lands after a cycle ends, so the',
    'newest records may lag today by several days. Always state the period a',
    'figure actually covers; if the latest pay week ends before the period the',
    'user asked about, say the data is not in yet rather than presenting older',
    'numbers as current.',
  ].join('\n');
}

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
  const systemPrompt = buildSystemPrompt(new Date()); // stamp once per request

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
            system: systemPrompt,
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
