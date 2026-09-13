import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_DELIM,
  MAX_FRAME_CHARS,
  encodeFrame,
  splitFrames,
  type PennyFrame,
} from "./console-stream";

/**
 * The whole point of this parser is that a frame is INVISIBLE to the answer.
 * Every case below is about one of two failures: a delimiter reaching the
 * transcript, or a frame straddling a network chunk being read as half a frame.
 */

/** Feeds a stream through the parser one slice at a time, exactly as the hook
 *  does — carrying `rest` in front of the next chunk. */
function drain(chunks: string[]): { text: string; frames: PennyFrame[] } {
  let rest = "";
  let text = "";
  const frames: PennyFrame[] = [];
  for (const chunk of chunks) {
    const out = splitFrames(rest + chunk);
    rest = out.rest;
    text += out.text;
    frames.push(...out.frames);
  }
  return { text, frames };
}

/* ── A stream with no frames is untouched ────────────────────────────────── */

test("plain text passes through byte-for-byte", () => {
  const body = "Kane was paid ₱12,480 on 09-02.\n\n| Week | Pay |\n|---|---:|\n";
  const out = splitFrames(body);
  assert.equal(out.text, body);
  assert.deepEqual(out.frames, []);
  assert.equal(out.rest, "");
});

test("a frameless stream is identical however it is chunked", () => {
  const body = "The audit log shows two edits, both by kaner@simple.biz.";
  for (let i = 0; i <= body.length; i++) {
    const { text, frames } = drain([body.slice(0, i), body.slice(i)]);
    assert.equal(text, body, `split at ${i}`);
    assert.deepEqual(frames, []);
  }
});

/* ── Frames are extracted and never rendered ─────────────────────────────── */

test("a frame between two runs of text is lifted out", () => {
  const stream = `Looking now.${encodeFrame({ t: "tool", name: "search_audit_log" })}Found two events.`;
  const out = splitFrames(stream);
  assert.equal(out.text, "Looking now.Found two events.");
  assert.deepEqual(out.frames, [{ t: "tool", name: "search_audit_log" }]);
});

test("several frames in one chunk keep arrival order", () => {
  const stream =
    encodeFrame({ t: "tool", name: "find_employee" }) +
    encodeFrame({ t: "tool", name: "get_rate_history" }) +
    "Her rate went to ₱180 on 08-11.";
  const out = splitFrames(stream);
  assert.equal(out.text, "Her rate went to ₱180 on 08-11.");
  // Narrowed by `t` before reading `name` — the union has a second member now,
  // and this is exactly the read that would have silently yielded `undefined`.
  assert.deepEqual(
    out.frames.filter((f) => f.t === "tool").map((f) => f.name),
    ["find_employee", "get_rate_history"],
  );
});

/**
 * The chunk-boundary case this parser exists for: a frame cut anywhere at all
 * must still yield the same text and the same one frame. Walking EVERY split
 * point is the only way to catch an off-by-one in the held tail.
 */
test("a frame split at any point survives — text and frame both intact", () => {
  const stream = `before${encodeFrame({ t: "tool", name: "run_diagnostics" })}after`;
  for (let i = 0; i <= stream.length; i++) {
    const { text, frames } = drain([stream.slice(0, i), stream.slice(i)]);
    assert.equal(text, "beforeafter", `split at ${i}`);
    assert.deepEqual(frames, [{ t: "tool", name: "run_diagnostics" }], `split at ${i}`);
  }
});

test("no delimiter ever reaches the transcript, at any chunking", () => {
  const stream =
    `a${encodeFrame({ t: "tool", name: "find_employee" })}b` +
    `${encodeFrame({ t: "tool", name: "get_employee_pay" })}c`;
  for (let i = 0; i <= stream.length; i++) {
    for (let j = i; j <= stream.length; j++) {
      const { text } = drain([stream.slice(0, i), stream.slice(i, j), stream.slice(j)]);
      assert.ok(!text.includes(FRAME_DELIM), `delimiter leaked at ${i}/${j}`);
    }
  }
});

/* ── Malformed input degrades to silence, never to junk in the answer ────── */

test("an unparsable frame is dropped, and its delimiters with it", () => {
  const stream = `x${FRAME_DELIM}{not json${FRAME_DELIM}y`;
  const out = splitFrames(stream);
  assert.equal(out.text, "xy");
  assert.deepEqual(out.frames, []);
});

test("an unknown frame type is ignored, so a newer route cannot break this client", () => {
  const stream = `${FRAME_DELIM}{"t":"turn","n":2}${FRAME_DELIM}ok`;
  const out = splitFrames(stream);
  assert.equal(out.text, "ok");
  assert.deepEqual(out.frames, []);
});

test("a frame missing its name is ignored", () => {
  const out = splitFrames(`${FRAME_DELIM}{"t":"tool"}${FRAME_DELIM}done`);
  assert.equal(out.text, "done");
  assert.deepEqual(out.frames, []);
});

test("an unterminated frame is held, not flushed as text", () => {
  const out = splitFrames(`text${FRAME_DELIM}{"t":"tool","na`);
  assert.equal(out.text, "text");
  assert.ok(out.rest.startsWith(FRAME_DELIM));
  assert.deepEqual(out.frames, []);
});

test("an unterminated frame past the cap is discarded, never appended", () => {
  const out = splitFrames(`text${FRAME_DELIM}${"x".repeat(MAX_FRAME_CHARS + 1)}`);
  assert.equal(out.text, "text");
  assert.equal(out.rest, "");
  assert.ok(!out.text.includes(FRAME_DELIM));
});

/* ── Negative control ────────────────────────────────────────────────────── */

/**
 * If `encodeFrame` ever stopped wrapping in the delimiter, every test above
 * would still pass while the parser did nothing — the frames would simply read
 * as text. Pin the wire format itself.
 */
test("encodeFrame wraps compact JSON in the delimiter", () => {
  const wire = encodeFrame({ t: "tool", name: "get_change_timeline" });
  assert.equal(wire.at(0), FRAME_DELIM);
  assert.equal(wire.at(-1), FRAME_DELIM);
  assert.equal(wire.slice(1, -1), '{"t":"tool","name":"get_change_timeline"}');
  // NUL specifically: the model cannot emit one, which is what makes a frame
    // unforgeable by a reply. Spelled without a literal control character.
    assert.equal(FRAME_DELIM, String.fromCharCode(0));
    assert.equal(FRAME_DELIM.length, 1);
});

/* ── Attachment frames ───────────────────────────────────────────────────── */

/**
 * A second frame kind is the thing the "unknown types are ignored" rule was
 * written for. These pin that adding one did not change what a TEXT stream
 * looks like, and that a half-valid frame is dropped whole rather than admitted
 * with a hole in it — the consumers read `r`/`l`/`k` without re-checking them.
 */
test("an attachment frame survives every chunk boundary, text untouched", () => {
  const frame = encodeFrame({ t: "att", r: "receipt~0f9c2a44-1f6e-4d5b-9a1f-2c3d4e5f6a7b", l: "MESA receipt", k: "image" });
  const stream = `Found one file.${frame} It is a receipt.`;
  for (let cut = 0; cut <= stream.length; cut++) {
    const out = drain([stream.slice(0, cut), stream.slice(cut)]);
    assert.equal(out.text, "Found one file. It is a receipt.", `split at ${cut}`);
    assert.equal(out.frames.length, 1, `split at ${cut}`);
    assert.deepEqual(out.frames[0], {
      t: "att",
      r: "receipt~0f9c2a44-1f6e-4d5b-9a1f-2c3d4e5f6a7b",
      l: "MESA receipt",
      k: "image",
    });
  }
});

test("tool and attachment frames interleave in arrival order", () => {
  const out = drain([
    encodeFrame({ t: "tool", name: "list_employee_attachments" }),
    "Two files.",
    encodeFrame({ t: "att", r: "photo~jane@simple.biz", l: "Profile photo", k: "image" }),
    encodeFrame({ t: "att", r: "w8ben~0f9c2a44-1f6e-4d5b-9a1f-2c3d4e5f6a7b", l: "W-8BEN", k: "pdf" }),
  ]);
  assert.equal(out.text, "Two files.");
  assert.deepEqual(out.frames.map((f) => f.t), ["tool", "att", "att"]);
});

test("a malformed attachment frame is dropped whole, never half-built", () => {
  const bad = [
    '{"t":"att","r":"photo~jane@simple.biz","l":"Photo"}',      // no kind
    '{"t":"att","r":"photo~jane@simple.biz","k":"image"}',      // no label
    '{"t":"att","l":"Photo","k":"image"}',                      // no ref
    '{"t":"att","r":"photo~jane@simple.biz","l":"","k":"image"}', // empty label
    '{"t":"att","r":"photo~jane@simple.biz","l":"Photo","k":"video"}', // unknown kind
    '{"t":"att","r":12,"l":"Photo","k":"image"}',               // wrong type
  ];
  for (const raw of bad) {
    const out = drain([`before${FRAME_DELIM}${raw}${FRAME_DELIM}after`]);
    assert.equal(out.frames.length, 0, `accepted a malformed frame: ${raw}`);
    assert.equal(out.text, "beforeafter", "and it must not leak into the transcript");
  }
});

test("an unknown frame type is still ignored, and takes no text with it", () => {
  const out = drain([`a${FRAME_DELIM}{"t":"future","x":1}${FRAME_DELIM}b`]);
  assert.equal(out.frames.length, 0);
  assert.equal(out.text, "ab");
});
