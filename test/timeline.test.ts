import test from "node:test";
import assert from "node:assert/strict";
import { renderTimeline } from "../src/timeline";

test("renderTimeline rejects empty clips", async () => {
  await assert.rejects(async () => {
    await renderTimeline([], "/tmp/x.wav");
  });
});
