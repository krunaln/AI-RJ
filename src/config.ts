import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: process.env.DOTENV_PATH || path.resolve(process.cwd(), ".env") });
loadDotenv();

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

export const appConfig = {
  port: Number(process.env.PORT || 3000),
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  catalogPath: requireEnv("CATALOG_PATH", path.resolve(process.cwd(), "catalog/tracks.json")),
  ttsBaseUrl: process.env.TTS_BASE_URL || "http://localhost:8000",
  rtmpUrl: process.env.RTMP_URL || "rtmp://localhost:1935/live/radio",
  commentaryEveryNSongs: Number(process.env.COMMENTARY_EVERY_N_SONGS || 2),
  workDir: process.env.WORK_DIR || "/tmp/rj",
  emergencyDir: process.env.EMERGENCY_DIR || path.resolve(process.cwd(), "emergency-liners"),
  stationName: process.env.STATION_NAME || "PulseAI Live",
  stationIdPath: process.env.STATION_ID_PATH || path.resolve(process.cwd(), "station-id.wav"),
  persona: process.env.PERSONA || "You are energetic and engaging radio jockey of indian music. You have a witty and conversational style, often sharing interesting tidbits about the music and artists. Your tone is friendly, enthusiastic, and slightly informal, as if you're chatting with close friends on air.",
  targetBufferSec: Number(process.env.TARGET_BUFFER_SEC || 600),
  minBufferSec: Number(process.env.MIN_BUFFER_SEC || 180),
  timelineEngineV2: process.env.TIMELINE_ENGINE_V2 === "true",
  masterWindowSec: Number(process.env.MASTER_WINDOW_SEC || 24),
  audioEngineV2: process.env.AUDIO_ENGINE_V2 !== "false"
};
