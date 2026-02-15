import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalog } from "../src/catalog";

test("loadCatalog parses valid tracks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
  const file = path.join(dir, "tracks.json");

  await writeFile(
    file,
    JSON.stringify([
      {
        id: "t1",
        title: "Song",
        artist: "Artist",
        youtube_url: "https://youtube.com/watch?v=abc123",
        duration_sec: 180,
        tags: ["pop"],
        energy: 0.5,
        mood: "happy",
        language: "en"
      }
    ])
  );

  const tracks = await loadCatalog(file);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.id, "t1");
});
