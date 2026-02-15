import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { execCmd } from "./proc";
import type { Track } from "./types";

export class YouTubeAudioService {
  private readonly cacheDir: string;
  private downloaderArgs: string[] | null = null;
  private readonly clipSeconds = 60;

  constructor(workDir: string) {
    this.cacheDir = path.join(workDir, "yt-cache");
  }

  async init(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    this.downloaderArgs = await this.resolveDownloader();
  }

  async fetchTrackWav(track: Track): Promise<string> {
    const outBase = path.join(this.cacheDir, `${track.id}-${this.clipSeconds}s`);
    const outWav = `${outBase}.wav`;
    try {
      await access(outWav);
      const duration = await this.readDurationSec(outWav);
      if (duration > 0 && duration <= this.clipSeconds + 0.25) {
        return outWav;
      }
      // Cached file exists but is not clipped as expected; regenerate it.
    } catch {
      // Cache miss; continue.
    }

    const downloader = this.downloaderArgs ?? (await this.resolveDownloader());
    const [bin, ...baseArgs] = downloader;
    await execCmd(bin, [
      ...baseArgs,
      "--no-playlist",
      "-f",
      "bestaudio",
      "--extract-audio",
      "--audio-format",
      "wav",
      "-o",
      `${outBase}.%(ext)s`,
      track.youtube_url
    ]);

    await execCmd("ffmpeg", [
      "-y",
      "-i",
      outWav,
      "-t",
      String(this.clipSeconds),
      "-ar",
      "48000",
      "-ac",
      "2",
      `${outBase}.norm.wav`
    ]);

    await rename(`${outBase}.norm.wav`, outWav);

    return outWav;
  }

  private async readDurationSec(filePath: string): Promise<number> {
    try {
      const { stdout } = await execCmd("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ]);
      const v = Number(stdout.trim());
      return Number.isFinite(v) ? v : -1;
    } catch {
      return -1;
    }
  }

  private async resolveDownloader(): Promise<string[]> {
    try {
      await execCmd("yt-dlp", ["--version"]);
      return ["yt-dlp"];
    } catch {
      // Fall through to python module check.
    }

    try {
      await execCmd("python3", ["-m", "yt_dlp", "--version"]);
      return ["python3", "-m", "yt_dlp"];
    } catch {
      throw new Error(
        "yt-dlp is not installed. Install it with `brew install yt-dlp` or `python3 -m pip install -U yt-dlp`."
      );
    }
  }
}
