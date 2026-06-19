import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { resolveAnthropicApiKey } from '@/lib/anthropic/api-key';

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
  'the company\'s internal HRIS (a payroll, attendance, and workforce-operations',
  'platform). You speak with the CEO directly.',
  '',
  'Be warm, concise, and direct. Lead with the answer, then any supporting',
  'detail. Default to a few sentences; use short bullet lists only when they',
  'genuinely help. Skip preamble like "Great question" or "As an AI".',
  '',
  'You can help the CEO think through decisions, draft announcements and',
  'messages, summarize or restructure text they paste in, explain how parts of',
  'the dashboard work (Overview, Announcements, Notifications, the S-Wall team',
  'feed), and answer general questions. You do not have live access to payroll,',
  'employee records, or any company data — if asked for specific figures, say so',
  'plainly and offer to help once they paste the numbers in.',
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

  // 4. Stream Claude's reply back as plain text chunks.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const claudeStream = client.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
          system: SYSTEM_PROMPT,
          messages,
        });

        claudeStream.on('text', (delta) => {
          controller.enqueue(encoder.encode(delta));
        });

        await claudeStream.finalMessage();
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The status line is already 200 by the time we stream; surface the
        // failure inline so the widget can show it to the user.
        controller.enqueue(encoder.encode(`\n\n[Assistant error: ${msg}]`));
        controller.close();
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
