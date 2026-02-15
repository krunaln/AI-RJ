import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeState } from "../src/runtime-state";

test("runtime state tracks queue start finish", () => {
  const runtime = new RuntimeState();

  runtime.enqueueSegment(
    {
      id: "seg-1",
      type: "songs",
      filePath: "/tmp/a.wav",
      durationSec: 12,
      notes: "a"
    },
    12
  );

  let snap = runtime.snapshot();
  assert.equal(snap.queue.length, 1);
  assert.equal(snap.nowPlaying, null);

  runtime.segmentStarted("seg-1");
  snap = runtime.snapshot();
  assert.equal(snap.queue.length, 0);
  assert.equal(snap.nowPlaying?.id, "seg-1");

  runtime.segmentFinished("seg-1", 0);
  snap = runtime.snapshot();
  assert.equal(snap.nowPlaying, null);
  assert.equal(snap.recentSegments.length, 1);
  assert.equal(snap.stats.segmentsByType.songs, 1);
});

test("runtime state removes queued segment", () => {
  const runtime = new RuntimeState();
  runtime.enqueueSegment(
    {
      id: "seg-rm",
      type: "commentary",
      filePath: "/tmp/rm.wav",
      durationSec: 5,
      notes: "hello"
    },
    5
  );
  const removed = runtime.removeQueuedSegment("seg-rm", 0);
  assert.equal(removed, true);
  const snap = runtime.snapshot();
  assert.equal(snap.queue.length, 0);
});

test("runtime state event history is bounded", () => {
  const runtime = new RuntimeState();

  for (let i = 0; i < 250; i += 1) {
    runtime.setCore({ bufferedSec: i });
  }

  const snap = runtime.snapshot();
  assert.equal(snap.recentEvents.length, 200);
});
