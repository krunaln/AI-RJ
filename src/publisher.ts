import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { execCmd } from "./proc";
import { log, logError } from "./log";
import type { RenderedSegment } from "./types";

type QueueItem = {
  segment: RenderedSegment;
  enqueuedAtMs: number;
};

type PublisherHooks = {
  onStarted?: (rtmpUrl: string) => void;
  onStopped?: () => void;
  onError?: (message: string, exitCode?: number | null) => void;
  onFfmpegLine?: (line: string) => void;
  onSegmentStarted?: (segmentId: string) => void;
  onSegmentFinished?: (segmentId: string, bufferedSec: number) => void;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RtmpPublisher {
  private readonly fifoPath: string;
  private ffmpegIngest?: ReturnType<typeof spawn>;
  private fifoWriter?: ReturnType<typeof createWriteStream>;
  private queue: QueueItem[] = [];
  private running = false;
  private processing = false;
  private bufferedSec = 0;
  private currentTranscode?: ReturnType<typeof spawn>;

  constructor(
    private readonly workDir: string,
    private readonly rtmpUrl: string,
    private readonly hooks: PublisherHooks = {}
  ) {
    this.fifoPath = path.join(workDir, "live.pcm");
  }

  getBufferedSec(): number {
    return this.bufferedSec;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.workDir, { recursive: true });

    await execCmd("rm", ["-f", this.fifoPath]);
    await execCmd("mkfifo", [this.fifoPath]);

    const ffmpegIngest = spawn("ffmpeg", [
      "-loglevel",
      "error",
      "-re",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      this.fifoPath,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-f",
      "flv",
      this.rtmpUrl
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this.ffmpegIngest = ffmpegIngest;

    ffmpegIngest.stderr?.on("data", (d) => {
      const line = String(d).trim();
      if (line) {
        log("publisher.ffmpeg", { line });
        this.hooks.onFfmpegLine?.(line);
      }
    });

    ffmpegIngest.on("exit", (code) => {
      logError("publisher.exit", new Error(`ffmpeg ingest exited ${code ?? -1}`));
      this.hooks.onError?.("ffmpeg ingest exited", code ?? null);
      this.running = false;
    });

    this.fifoWriter = createWriteStream(this.fifoPath);
    this.running = true;
    this.processLoop().catch((err) => logError("publisher.loop.error", err));
    log("publisher.started", { rtmpUrl: this.rtmpUrl });
    this.hooks.onStarted?.(this.rtmpUrl);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue = [];
    this.bufferedSec = 0;
    this.fifoWriter?.end();
    this.ffmpegIngest?.kill("SIGTERM");
    log("publisher.stopped");
    this.hooks.onStopped?.();
  }

  enqueue(segment: RenderedSegment): void {
    this.queue.push({ segment, enqueuedAtMs: Date.now() });
    this.queue.sort((a, b) => {
      const aPinned = Boolean(a.segment.pinned);
      const bPinned = Boolean(b.segment.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aPriority = typeof a.segment.priority === "number" ? a.segment.priority : a.segment.source === "manual" ? 100 : 50;
      const bPriority = typeof b.segment.priority === "number" ? b.segment.priority : b.segment.source === "manual" ? 100 : 50;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return a.enqueuedAtMs - b.enqueuedAtMs;
    });
    this.bufferedSec += segment.durationSec;
  }

  removeQueuedSegment(segmentId: string): boolean {
    const idx = this.queue.findIndex((q) => q.segment.id === segmentId);
    if (idx === -1) {
      return false;
    }
    const [removed] = this.queue.splice(idx, 1);
    this.bufferedSec = Math.max(0, this.bufferedSec - removed.segment.durationSec);
    return true;
  }

  updateQueuedSegment(segmentId: string, patch: { priority?: number; pinned?: boolean }): boolean {
    const idx = this.queue.findIndex((q) => q.segment.id === segmentId);
    if (idx === -1) {
      return false;
    }
    const cur = this.queue[idx];
    cur.segment = {
      ...cur.segment,
      priority: typeof patch.priority === "number" ? patch.priority : cur.segment.priority,
      pinned: typeof patch.pinned === "boolean" ? patch.pinned : cur.segment.pinned
    };
    this.queue.sort((a, b) => {
      const aPinned = Boolean(a.segment.pinned);
      const bPinned = Boolean(b.segment.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aPriority = typeof a.segment.priority === "number" ? a.segment.priority : a.segment.source === "manual" ? 100 : 50;
      const bPriority = typeof b.segment.priority === "number" ? b.segment.priority : b.segment.source === "manual" ? 100 : 50;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return a.enqueuedAtMs - b.enqueuedAtMs;
    });
    return true;
  }

  skipCurrentSegment(): boolean {
    if (!this.currentTranscode) {
      return false;
    }
    this.currentTranscode.kill("SIGTERM");
    return true;
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.running) {
      const next = this.queue.shift();
      if (!next) {
        await wait(300);
        continue;
      }

      try {
        this.hooks.onSegmentStarted?.(next.segment.id);
        await this.streamFile(next.segment.filePath);
      } catch (error) {
        logError("publisher.stream.error", error, { filePath: next.segment.filePath });
        this.hooks.onError?.(
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.bufferedSec = Math.max(0, this.bufferedSec - next.segment.durationSec);
        this.hooks.onSegmentFinished?.(next.segment.id, this.bufferedSec);
      }
    }

    this.processing = false;
  }

  private async streamFile(filePath: string): Promise<void> {
    if (!this.fifoWriter) {
      throw new Error("FIFO writer is not initialized");
    }

    await new Promise<void>((resolve, reject) => {
      const transcode = spawn("ffmpeg", [
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1"
      ], { stdio: ["ignore", "pipe", "pipe"] });
      this.currentTranscode = transcode;

      transcode.stderr.on("data", (d) => {
        const line = String(d).trim();
        if (line) {
          log("publisher.transcode", { line, filePath });
        }
      });

      transcode.stdout.pipe(this.fifoWriter!, { end: false });
      transcode.on("error", reject);
      transcode.on("close", (code) => {
        this.currentTranscode = undefined;
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`transcode failed with ${code}`));
      });
    });
  }
}
