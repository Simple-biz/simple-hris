import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_COMMAND_HINTS,
  resolveConsoleCommand,
} from "./console-commands";

/**
 * Every case here is about one question: does this input belong to the console
 * or to Penny? Getting it wrong in the "console" direction is the bad one — the
 * question vanishes and the admin thinks it was handled.
 */

/* ── What the console owns ───────────────────────────────────────────────── */

test("/clear clears", () => {
  assert.equal(resolveConsoleCommand("/clear"), "clear");
});

test("/clear is recognised regardless of case or surrounding whitespace", () => {
  for (const raw of ["/CLEAR", "/Clear", "  /clear  ", "\t/clear\n"]) {
    assert.equal(resolveConsoleCommand(raw), "clear", `failed on ${JSON.stringify(raw)}`);
  }
});

/* ── What must still reach Penny ─────────────────────────────────────────── */

/**
 * The bare word is NOT a command. "clear" is a plausible thing to ask about a
 * payroll note or a dispute, and stealing it would silently drop a question.
 */
test("bare 'clear' is a question, not a command", () => {
  assert.equal(resolveConsoleCommand("clear"), null);
  assert.equal(resolveConsoleCommand("Clear"), null);
});

test("a question that merely contains the command is passed through", () => {
  const questions = [
    "did anyone /clear the audit log?",
    "/clear the dispute for franm@simple.biz",
    "clear out the payroll notes for last week",
    "who cleared the payroll note?",
    "is the readiness check clear?",
  ];
  for (const q of questions) {
    assert.equal(resolveConsoleCommand(q), null, `swallowed: ${q}`);
  }
});

test("an unknown slash word goes to Penny rather than being rejected", () => {
  for (const q of ["/help", "/status", "/", "//", "/clearx", "/clear-all"]) {
    assert.equal(resolveConsoleCommand(q), null, `claimed: ${q}`);
  }
});

test("empty and whitespace-only input owns nothing", () => {
  for (const q of ["", "   ", "\n"]) {
    assert.equal(resolveConsoleCommand(q), null);
  }
});

/* ── The hint is the only affordance, so it must be accurate ─────────────── */

/**
 * A command with no visible affordance does not exist for the user. The hint
 * row is that affordance, so every command it advertises must actually resolve
 * — a hint naming a command that does nothing is worse than no hint.
 */
test("every advertised command actually resolves", () => {
  assert.ok(CONSOLE_COMMAND_HINTS.length > 0, "no commands are advertised");
  for (const { command, describes } of CONSOLE_COMMAND_HINTS) {
    assert.notEqual(
      resolveConsoleCommand(command),
      null,
      `hint advertises ${command}, which resolves to nothing`,
    );
    assert.ok(describes.length > 0, `${command} has no description`);
    assert.ok(!/[.!]$/.test(describes), `${command} description should not end in a full stop`);
  }
});
