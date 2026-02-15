import test from "node:test";
import assert from "node:assert/strict";
import { formatSseEvent } from "../src/sse";

test("formatSseEvent returns valid SSE data line", () => {
  const raw = formatSseEvent({
    ts: "2026-02-14T00:00:00.000Z",
    event: "segment.enqueued",
    payload: { id: "x" }
  });

  assert.ok(raw.includes("event: message"));
  assert.ok(raw.includes("data: "));
  assert.ok(raw.endsWith("\n\n"));
});
