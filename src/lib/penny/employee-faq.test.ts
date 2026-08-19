import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEE_FAQS,
  GREETING_AUTOHIDE_MS,
  GREETING_DELAY_MS,
  GREETING_FAQ_COUNT,
  GREETING_TEXT,
  allFaqQuestions,
  greetingFaqs,
  shouldShowGreeting,
} from "./employee-faq";
import { EMPLOYEE_TOOLS } from "@/lib/anthropic/employee-tool-defs";

/**
 * A proactive greeting is a promise Penny made on its own initiative, so the
 * standard is higher than for a typed question: an offer Penny cannot fulfil
 * spends one of the employee's ten prompts on an apology.
 */

test("Kane asked for at least 5 — there are at least 5, all unique", () => {
  assert.ok(EMPLOYEE_FAQS.length >= 5, `only ${EMPLOYEE_FAQS.length} FAQs`);
  const qs = EMPLOYEE_FAQS.map((f) => f.question);
  assert.equal(new Set(qs).size, qs.length, "duplicate question text");
  const shorts = EMPLOYEE_FAQS.map((f) => f.short);
  assert.equal(new Set(shorts).size, shorts.length, "duplicate short label");
});

test("PROMISE: every FAQ names a tool that actually exists", () => {
  // The rule this file exists for. Adding "How much leave do I have left?" would
  // fail here, because no tool answers it — the HRIS tracks no leave balance.
  const tools = new Set(EMPLOYEE_TOOLS.map((t) => t.name));
  for (const faq of EMPLOYEE_FAQS) {
    assert.ok(
      tools.has(faq.tool),
      `FAQ "${faq.question}" claims tool ${faq.tool}, which is not in EMPLOYEE_TOOLS — ` +
        "Penny would offer a question it cannot answer and burn a prompt saying so.",
    );
  }
});

test("the FAQ set spans the assistant's real ground, not one tool five times", () => {
  // A greeting that only ever asks about pay teaches employees Penny does one
  // thing. At least four distinct tools must be represented.
  const distinct = new Set(EMPLOYEE_FAQS.map((f) => f.tool));
  assert.ok(distinct.size >= 4, `only ${distinct.size} distinct tools covered`);
});

test("no FAQ asks for something the system deliberately does not hold", () => {
  // Each of these has a documented reason to be absent: no leave balance is
  // tracked; peer data is unreachable by construction; the notice period is
  // per-team and unpublished for ~15 teams, so "the notice period" alone cannot
  // be answered generically (the leave FAQ asks it in context, which the guide
  // handles per-team).
  const text = EMPLOYEE_FAQS.map((f) => `${f.question} ${f.short}`).join(" ").toLowerCase();
  for (const forbidden of [
    "how much leave do i have",
    "leave balance",
    "days remaining",
    "my team's pay",
    "who earns",
    "everyone",
    "colleague",
    "am i getting the pab", // eligibility — the tool deliberately does not judge it
    "did i earn",
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `FAQ offers "${forbidden}", which Penny cannot answer`,
    );
  }
});

test("questions are phrased as an employee would type them", () => {
  for (const faq of EMPLOYEE_FAQS) {
    assert.ok(faq.question.endsWith("?"), `"${faq.question}" should be a question`);
    assert.ok(faq.question.length > 12, `"${faq.question}" is too terse to route well`);
    // The short label has to fit a 380px balloon chip.
    assert.ok(
      faq.short.length <= 30,
      `short label "${faq.short}" (${faq.short.length}) will wrap in the balloon`,
    );
  }
});

test("the greeting offers a few, and the panel offers all of them", () => {
  assert.equal(greetingFaqs().length, GREETING_FAQ_COUNT);
  assert.ok(GREETING_FAQ_COUNT >= 3 && GREETING_FAQ_COUNT <= 4, "balloon holds 3–4 chips");
  assert.equal(allFaqQuestions().length, EMPLOYEE_FAQS.length);
  // Nothing offered in the balloon is missing from the full list.
  for (const f of greetingFaqs()) {
    assert.ok(allFaqQuestions().includes(f.question));
  }
});

test("greetingFaqs is defensive about its count", () => {
  assert.deepEqual(greetingFaqs(0), []);
  assert.deepEqual(greetingFaqs(-3), []);
  assert.equal(greetingFaqs(99).length, EMPLOYEE_FAQS.length);
});

test("the timings match the spec and leave on their own", () => {
  assert.equal(GREETING_DELAY_MS, 5_000, "Kane specified five seconds");
  assert.ok(
    GREETING_AUTOHIDE_MS > GREETING_DELAY_MS,
    "the balloon must outlive its own appearance",
  );
  assert.ok(
    GREETING_AUTOHIDE_MS <= 30_000,
    "a proactive balloon that never leaves becomes furniture on the dashboard",
  );
});

test("the greeting text is an offer, not an announcement", () => {
  assert.match(GREETING_TEXT, /\?$/);
  assert.match(GREETING_TEXT, /help/i);
});

/* ── When the balloon may show ───────────────────────────────────────────── */

const READY = {
  armed: true,
  panelOpen: false,
  quotaExhausted: false,
  widgetHidden: false,
  messageCount: 0,
};

test("the balloon shows only once the fuse has elapsed", () => {
  assert.equal(shouldShowGreeting(READY), true);
  assert.equal(shouldShowGreeting({ ...READY, armed: false }), false);
});

test("SUPPRESSED: out of prompts — never invite a question they cannot ask", () => {
  // The case nobody would click through by hand, and the one that matters most:
  // being greeted with "anything I can help with?" when the composer is greyed
  // out is the assistant mocking them.
  assert.equal(shouldShowGreeting({ ...READY, quotaExhausted: true }), false);
});

test("SUPPRESSED: the panel is already open, or a conversation exists", () => {
  assert.equal(shouldShowGreeting({ ...READY, panelOpen: true }), false);
  assert.equal(shouldShowGreeting({ ...READY, messageCount: 1 }), false);
  // Both at once, and after the panel is closed again mid-conversation.
  assert.equal(shouldShowGreeting({ ...READY, panelOpen: false, messageCount: 4 }), false);
});

test("SUPPRESSED: the shell hid the widget", () => {
  assert.equal(shouldShowGreeting({ ...READY, widgetHidden: true }), false);
});

test("every single suppression flag is sufficient on its own", () => {
  // Guards against a future edit turning an early return into a combined &&.
  const flags: (keyof typeof READY)[] = [
    "panelOpen",
    "quotaExhausted",
    "widgetHidden",
  ];
  for (const flag of flags) {
    assert.equal(
      shouldShowGreeting({ ...READY, [flag]: true }),
      false,
      `${flag} alone must suppress the balloon`,
    );
  }
  assert.equal(shouldShowGreeting({ ...READY, messageCount: 1 }), false);
});
