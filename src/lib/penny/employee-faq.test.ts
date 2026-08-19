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
  pickFaqs,
  readLastShown,
  shouldShowGreeting,
  writeLastShown,
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

test("the greeting offers five, and the panel offers all of them", () => {
  assert.equal(GREETING_FAQ_COUNT, 5, "Kane asked for five");
  assert.equal(greetingFaqs().length, GREETING_FAQ_COUNT);
  assert.equal(allFaqQuestions().length, EMPLOYEE_FAQS.length);
  // Nothing offered in the balloon is missing from the full list.
  for (const f of greetingFaqs()) {
    assert.ok(allFaqQuestions().includes(f.question));
  }
});

/* ── "each time refresh should be different" ─────────────────────────────── */

test("the pool is big enough to show five FRESH chips every load", () => {
  // The rotation guarantee below only holds while pool ≥ 2 × count. Adding a
  // sixth chip or deleting FAQs without checking this is how "different every
  // refresh" quietly degrades to "mostly different".
  assert.ok(
    EMPLOYEE_FAQS.length >= GREETING_FAQ_COUNT * 2,
    `pool of ${EMPLOYEE_FAQS.length} cannot guarantee ${GREETING_FAQ_COUNT} fresh chips`,
  );
});

test("GUARANTEE: a pick shares nothing with the previous pick", () => {
  // Not "usually different" — different. A repeat is what would read as broken.
  let previous = pickFaqs(GREETING_FAQ_COUNT, []);
  for (let load = 0; load < 40; load++) {
    const next = pickFaqs(GREETING_FAQ_COUNT, previous.map((f) => f.question));
    assert.equal(next.length, GREETING_FAQ_COUNT, `load ${load} returned a short list`);
    const overlap = next.filter((n) => previous.some((p) => p.question === n.question));
    assert.deepEqual(overlap, [], `load ${load} repeated a chip from the previous load`);
    previous = next;
  }
});

test("a pick never contains a duplicate of itself", () => {
  for (let i = 0; i < 25; i++) {
    const picked = pickFaqs(GREETING_FAQ_COUNT, []);
    const qs = picked.map((f) => f.question);
    assert.equal(new Set(qs).size, qs.length, "same chip twice in one balloon");
  }
});

test("the order actually varies between loads (it is shuffled, not sliced)", () => {
  // A deterministic slice would satisfy the no-overlap test above by alternating
  // two fixed halves forever. Inject a real RNG and check the arrangement moves.
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    seen.add(pickFaqs(GREETING_FAQ_COUNT, []).map((f) => f.question).join("|"));
  }
  assert.ok(seen.size > 1, "every pick produced the identical list — not shuffled");
});

test("pickFaqs tops up rather than returning a short list", () => {
  // If the exclusion list ever swallows the pool, five chips still beat three.
  const everything = EMPLOYEE_FAQS.map((f) => f.question);
  const picked = pickFaqs(GREETING_FAQ_COUNT, everything);
  assert.equal(picked.length, GREETING_FAQ_COUNT);
  assert.equal(new Set(picked.map((f) => f.question)).size, GREETING_FAQ_COUNT);
});

test("pickFaqs is defensive about its count", () => {
  assert.deepEqual(pickFaqs(0, []), []);
  assert.deepEqual(pickFaqs(-2, []), []);
  assert.equal(pickFaqs(999, []).length, EMPLOYEE_FAQS.length);
});

test("pickFaqs is deterministic under an injected RNG", () => {
  // Makes the shuffle reproducible for anyone debugging a bad-looking set.
  const seeded = () => {
    let n = 0;
    return () => ((n = (n * 9301 + 49297) % 233280), n / 233280);
  };
  const a = pickFaqs(GREETING_FAQ_COUNT, [], seeded());
  const b = pickFaqs(GREETING_FAQ_COUNT, [], seeded());
  assert.deepEqual(
    a.map((f) => f.question),
    b.map((f) => f.question),
  );
});

/* ── Remembering the previous load ───────────────────────────────────────── */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => map,
  };
}

test("last-shown round-trips through storage", () => {
  const s = fakeStorage();
  const picked = pickFaqs(GREETING_FAQ_COUNT, []);
  writeLastShown(s, picked);
  assert.deepEqual(readLastShown(s), picked.map((f) => f.question));
});

test("a missing, unavailable or corrupt store degrades to no exclusion", () => {
  // Private mode, cleared storage, a hand-edited value — rotation falls back to
  // plain random rather than throwing on the render path.
  assert.deepEqual(readLastShown(null), []);
  assert.deepEqual(readLastShown(fakeStorage()), []);
  assert.deepEqual(readLastShown(fakeStorage({ penny_faq_last_shown: "not json" })), []);
  assert.deepEqual(readLastShown(fakeStorage({ penny_faq_last_shown: '{"a":1}' })), []);
  // A mixed array keeps only the strings.
  assert.deepEqual(
    readLastShown(fakeStorage({ penny_faq_last_shown: '["ok",5,null]' })),
    ["ok"],
  );
});

test("writeLastShown survives a throwing storage", () => {
  const throwing = {
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
  };
  assert.doesNotThrow(() => writeLastShown(throwing, EMPLOYEE_FAQS.slice(0, 2)));
  assert.doesNotThrow(() => writeLastShown(null, EMPLOYEE_FAQS.slice(0, 2)));
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
