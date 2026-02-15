import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execCmd } from "./proc";
import { renderTimeline } from "./timeline";

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function concatFiles(inputs: string[], outFile: string): Promise<void> {
  const listFile = `${outFile}.txt`;
  const lines = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listFile, lines, "utf8");

  await execCmd("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:a",
    "pcm_s16le",
    outFile
  ]);
}

export async function crossfadeTwo(inputA: string, inputB: string, outFile: string, crossfadeSec = 3): Promise<void> {
  await execCmd("ffmpeg", [
    "-y",
    "-i",
    inputA,
    "-i",
    inputB,
    "-filter_complex",
    `[0:a][1:a]acrossfade=d=${crossfadeSec}:c1=tri:c2=tri[a]`,
    "-map",
    "[a]",
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function applyEdgeFades(inputFile: string, outFile: string, fadeInSec = 0.5, fadeOutSec = 0.7): Promise<void> {
  const duration = await getDurationSec(inputFile);
  const filters = [`afade=t=in:st=0:d=${Math.max(0, fadeInSec)}`];
  if (fadeOutSec > 0) {
    const fadeOutStart = Math.max(0, duration - fadeOutSec);
    filters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`);
  }
  await execCmd("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-af",
    filters.join(","),
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function trimAudioStart(inputFile: string, outFile: string, startSec: number): Promise<void> {
  const safeStart = Math.max(0, startSec);
  await execCmd("ffmpeg", [
    "-y",
    "-ss",
    safeStart.toFixed(3),
    "-i",
    inputFile,
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function trimAudioRange(inputFile: string, outFile: string, startSec: number, durationSec: number): Promise<void> {
  const safeStart = Math.max(0, startSec);
  const safeDuration = Math.max(0.2, durationSec);
  await execCmd("ffmpeg", [
    "-y",
    "-ss",
    safeStart.toFixed(3),
    "-i",
    inputFile,
    "-t",
    safeDuration.toFixed(3),
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function getDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);

  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Could not read duration for ${filePath}`);
  }
  return value;
}

export async function enhanceCommentaryVoice(inputFile: string, outFile: string, gain = 1.9): Promise<void> {
  await execCmd("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-af",
    `volume=${gain},loudnorm=I=-15:TP=-1.2:LRA=6,afade=t=in:st=0:d=0.25`,
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function mixCommentaryWithTrackBed(
  voiceFile: string,
  bedTrackFile: string,
  outFile: string,
  voiceDurationSec: number
): Promise<void> {
  const bedStartSec = Math.max(0, voiceDurationSec * 0.5);
  const bedPlayDuration = Math.max(0.8, voiceDurationSec - bedStartSec + 0.9);
  await renderTimeline(
    [
      {
        filePath: bedTrackFile,
        startSec: bedStartSec,
        durationSec: bedPlayDuration,
        gain: 0.32,
        fadeInSec: 0.5,
        fadeOutSec: 0.8
      },
      {
        filePath: voiceFile,
        startSec: 0,
        durationSec: voiceDurationSec,
        gain: 2.35,
        fadeInSec: 0.25,
        fadeOutSec: 0
      }
    ],
    outFile,
    { master: true }
  );
}

export async function prependStationId(stationIdFile: string, commentaryFile: string, outFile: string): Promise<void> {
  await execCmd("ffmpeg", [
    "-y",
    "-i",
    stationIdFile,
    "-i",
    commentaryFile,
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1[a]",
    "-map",
    "[a]",
    "-ar",
    "48000",
    "-ac",
    "2",
    outFile
  ]);
}

export async function silenceFile(outFile: string, seconds = 2): Promise<void> {
  await execCmd("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=48000:cl=stereo`,
    "-t",
    String(seconds),
    "-acodec",
    "pcm_s16le",
    outFile
  ]);
}

export function makeOutFile(workDir: string, prefix: string): string {
  return path.join(workDir, `${prefix}-${randomUUID()}.wav`);
}
