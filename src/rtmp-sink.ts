import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { execCmd } from "./proc";
import { log, logError } from "./log";

export type RtmpSinkHooks = {
  onStarted?: (rtmpUrl: string) => void;
  onStopped?: () => void;
  onError?: (message: string, exitCode?: number | null) => void;
  onFfmpegLine?: (line: string) => void;
};

export class RtmpSink {
  private readonly fifoPath: string;
  private ffmpegIngest?: ReturnType<typeof spawn>;
  private fifoWriter?: ReturnType<typeof createWriteStream>;
  private currentTranscode?: ReturnType<typeof spawn>;
  private running = false;

  constructor(
    private readonly workDir: string,
    private readonly rtmpUrl: string,
    private readonly hooks: RtmpSinkHooks = {}
  ) {
    this.fifoPath = path.join(workDir, "live.pcm");
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
        log("rtmpsink.ffmpeg", { line });
        this.hooks.onFfmpegLine?.(line);
      }
    });

    ffmpegIngest.on("exit", (code) => {
      logError("rtmpsink.exit", new Error(`ffmpeg ingest exited ${code ?? -1}`));
      this.hooks.onError?.("ffmpeg ingest exited", code ?? null);
      this.running = false;
    });

    this.fifoWriter = createWriteStream(this.fifoPath);
    this.running = true;
    this.hooks.onStarted?.(this.rtmpUrl);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.currentTranscode?.kill("SIGTERM");
    this.fifoWriter?.end();
    this.ffmpegIngest?.kill("SIGTERM");
    this.hooks.onStopped?.();
  }

  abortCurrentPush(): boolean {
    if (!this.currentTranscode) return false;
    this.currentTranscode.kill("SIGTERM");
    return true;
  }

  async pushFile(filePath: string): Promise<void> {
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
          log("rtmpsink.transcode", { line, filePath });
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
