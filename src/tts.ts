import { copyFile, writeFile } from "node:fs/promises";

export class TTSClient {
  constructor(private readonly baseUrl: string) {}

  async synthToFile(text: string, outFile: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    if (!res.ok) {
      throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("audio/")) {
      const arr = await res.arrayBuffer();
      await writeFile(outFile, Buffer.from(arr));
      return outFile;
    }

    const payload = (await res.json()) as Record<string, unknown>;
    await this.materializePayloadAudio(payload, outFile);
    return outFile;
  }

  private async materializePayloadAudio(payload: Record<string, unknown>, outFile: string): Promise<void> {
    const url = this.pickString(payload, ["audio_url", "url", "file_url", "download_url"]);
    if (url) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch TTS audio URL: ${url}`);
      }
      const arr = await res.arrayBuffer();
      await writeFile(outFile, Buffer.from(arr));
      return;
    }

    const filePath = this.pickString(payload, ["audio_path", "file_path", "path", "output_path"]);
    if (filePath) {
      await copyFile(filePath, outFile);
      return;
    }

    const base64 = this.pickString(payload, ["audio_base64", "wav_base64", "base64", "audio"]);
    if (base64) {
      const normalized = base64.startsWith("data:") ? base64.split(",")[1] : base64;
      if (!normalized) {
        throw new Error("Invalid base64 audio payload");
      }
      await writeFile(outFile, Buffer.from(normalized, "base64"));
      return;
    }

    throw new Error(`Unsupported TTS response payload keys: ${Object.keys(payload).join(", ")}`);
  }

  private pickString(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    return null;
  }
}
