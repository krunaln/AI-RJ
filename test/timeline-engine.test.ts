import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineSnapshot } from "../src/timeline-engine";
import type { DashboardSnapshot } from "../src/types";

function baseSnapshot(): DashboardSnapshot {
  return {
    running: true,
    streamStartedAt: new Date(Date.now() - 5000).toISOString(),
    phase: "songs",
    tracksLoaded: 3,
    bufferedSec: 180,
    lastError: null,
    nowPlaying: null,
    queue: [],
    recentSegments: [],
    recentEvents: [],
    recentErrors: [],
    publisher: { connected: true, reconnects: 0, lastExitCode: null, lastFfmpegLine: null },
    stats: {
      segmentsByType: { songs: 0, commentary: 0, liner: 0 },
      generationFailures: 0,
      fallbackLinerCount: 0,
      youtubeFetchErrors: 0,
      ttsFailures: 0
    },
    masterPlayhead: { elapsedSec: 0, currentSegmentElapsedSec: 0, currentSegmentRemainingSec: 0, timelineOffsetSec: 0 },
    deckA: { deck: "A", activeSegmentId: null, activeType: null, positionSec: 0, remainingSec: 0, nextSegmentId: null },
    deckB: { deck: "B", activeSegmentId: null, activeType: null, positionSec: 0, remainingSec: 0, nextSegmentId: null },
    voiceoverLane: { active: false, segmentId: null, positionSec: 0, remainingSec: 0 },
    crossfader: { active: false, fromDeck: null, toDeck: null, position: 0, curve: "tri", windowSec: 0, transitionStartTs: null },
    ducking: { active: false, reductionDb: 0 },
    lookaheadSecCovered: 0
  };
}

test("timeline engine prioritizes manual pinned in arbitration", () => {
  const s = baseSnapshot();
  s.queue = [
    { id: "a", type: "songs", filePath: "/tmp/a.wav", durationSec: 10, notes: "auto", enqueuedAt: new Date().toISOString(), source: "auto", priority: 50, pinned: false },
    { id: "m", type: "songs", filePath: "/tmp/m.wav", durationSec: 10, notes: "manual", enqueuedAt: new Date().toISOString(), source: "manual", priority: 100, pinned: true }
  ];
  const t = buildTimelineSnapshot(s);
  assert.equal(t.queueArbitration[0]?.segmentId, "a");
  assert.equal(t.queueArbitration[1]?.segmentId, "m");
  assert.equal(t.queueArbitration[1]?.reason, "manual_pinned");
});

test("timeline engine alternates deck assignment", () => {
  const s = baseSnapshot();
  s.queue = [
    { id: "s1", type: "songs", filePath: "/tmp/s1.wav", durationSec: 10, notes: "s1", enqueuedAt: new Date().toISOString(), source: "auto", priority: 50, pinned: false },
    { id: "s2", type: "songs", filePath: "/tmp/s2.wav", durationSec: 10, notes: "s2", enqueuedAt: new Date().toISOString(), source: "auto", priority: 50, pinned: false },
    { id: "s3", type: "songs", filePath: "/tmp/s3.wav", durationSec: 10, notes: "s3", enqueuedAt: new Date().toISOString(), source: "auto", priority: 50, pinned: false }
  ];

  const t = buildTimelineSnapshot(s);
  const decks = t.activeDeckClips.map((c) => c.deck);
  assert.deepEqual(decks, ["A", "B", "A"]);
});
