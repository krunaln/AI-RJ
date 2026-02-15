import express from "express";
import path from "node:path";
import { appConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { log, logError } from "./log";
import { formatSseEvent, heartbeatSseEvent } from "./sse";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const orchestrator = new Orchestrator();
const runtime = orchestrator.getRuntimeState();
const allowedMediaRoots = [path.resolve(appConfig.workDir), path.resolve(appConfig.emergencyDir)];

function isAllowedMediaPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return allowedMediaRoots.some((root) => resolved.startsWith(root));
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "rj-core" });
});

app.get("/status", (_req, res) => {
  res.json(orchestrator.status());
});

app.get("/dashboard/snapshot", (_req, res) => {
  res.json(runtime.snapshot());
});

app.get("/dashboard/queue", (_req, res) => {
  res.json(runtime.snapshot().queue);
});

app.get("/timeline/snapshot", (_req, res) => {
  res.json(orchestrator.getTimelineSnapshot());
});

app.post("/timeline/rebuild", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual";
  try {
    const timeline = orchestrator.rebuildTimeline(reason);
    res.json({ ok: true, timeline });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/dashboard/media/:segmentId", (req, res) => {
  const mediaPath = orchestrator.getMediaPath(req.params.segmentId);
  if (!mediaPath) {
    res.status(404).json({ ok: false, error: "segment media not found" });
    return;
  }
  res.sendFile(mediaPath, (err) => {
    if (err) {
      res.status(404).json({ ok: false, error: "media file unavailable" });
    }
  });
});

app.get("/dashboard/media-by-path", (req, res) => {
  const filePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!filePath) {
    res.status(400).json({ ok: false, error: "path query is required" });
    return;
  }
  if (!isAllowedMediaPath(filePath)) {
    res.status(403).json({ ok: false, error: "path not allowed" });
    return;
  }
  res.sendFile(path.resolve(filePath), (err) => {
    if (err) {
      res.status(404).json({ ok: false, error: "media file unavailable" });
    }
  });
});

app.get("/dashboard/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const snapshotEvent = {
    ts: new Date().toISOString(),
    event: "snapshot",
    payload: {},
    snapshot: runtime.snapshot()
  };
  res.write(formatSseEvent(snapshotEvent));

  const unsubscribe = runtime.subscribe((event) => {
    res.write(formatSseEvent(event));
  });

  const heartbeat = setInterval(() => {
    res.write(heartbeatSseEvent());
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.post("/dashboard/queue/commentary", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ ok: false, error: "text is required" });
    return;
  }
  try {
    const segment = await orchestrator.enqueueManualCommentary(text);
    res.json({ ok: true, segment });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/dashboard/queue/track", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const artist = typeof req.body?.artist === "string" ? req.body.artist.trim() : "";
  const youtube_url = typeof req.body?.youtube_url === "string" ? req.body.youtube_url.trim() : "";

  if (!title || !youtube_url) {
    res.status(400).json({ ok: false, error: "title and youtube_url are required" });
    return;
  }

  try {
    const segment = await orchestrator.enqueueManualTrack({ title, artist, youtube_url });
    res.json({ ok: true, segment });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.delete("/dashboard/queue/:segmentId", (req, res) => {
  const ok = orchestrator.removeQueuedSegment(req.params.segmentId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "segment not found in queue" });
    return;
  }
  res.json({ ok: true });
});

app.patch("/dashboard/queue/:segmentId", (req, res) => {
  const priorityRaw = req.body?.priority;
  const pinnedRaw = req.body?.pinned;
  const patch: { priority?: number; pinned?: boolean } = {};
  if (typeof priorityRaw === "number" && Number.isFinite(priorityRaw)) {
    patch.priority = Math.max(0, Math.min(200, Math.round(priorityRaw)));
  }
  if (typeof pinnedRaw === "boolean") {
    patch.pinned = pinnedRaw;
  }
  // accepted for forward compatibility in auto deck mode.
  if (typeof req.body?.targetDeck === "string") {
    // no-op for now
  }
  const ok = orchestrator.updateQueuedSegment(req.params.segmentId, patch);
  if (!ok) {
    res.status(404).json({ ok: false, error: "segment not found in queue" });
    return;
  }
  res.json({ ok: true });
});

app.post("/dashboard/transport/skip", (_req, res) => {
  const ok = orchestrator.skipCurrentSegment();
  if (!ok) {
    res.status(409).json({ ok: false, error: "no active segment to skip" });
    return;
  }
  res.json({ ok: true });
});

app.post("/control/start", async (_req, res) => {
  try {
    await orchestrator.start();
    res.json({ ok: true });
  } catch (error) {
    logError("control.start.error", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/control/stop", async (_req, res) => {
  try {
    await orchestrator.stop();
    res.json({ ok: true });
  } catch (error) {
    logError("control.stop.error", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.listen(appConfig.port, () => {
  log("server.listen", { port: appConfig.port });
});

process.on("SIGTERM", async () => {
  await orchestrator.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await orchestrator.stop();
  process.exit(0);
});
