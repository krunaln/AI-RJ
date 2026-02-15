# Agentic AI Radio Jockey MVP (Local Dev)

Local-first backend MVP that:
- Creates an autonomous 24/7 playlist flow (songs + AI commentary + transitions)
- Uses YouTube URLs from a JSON catalog as song sources (`yt-dlp` + `ffmpeg`)
- Calls external TTS API for speech segments
- Publishes live audio to MediaMTX over RTMP
- Exposes playback via HLS

## Prerequisites
- Node.js 20+
- `ffmpeg`, `ffprobe`, `yt-dlp` on host PATH
- Docker (only for running MediaMTX)
- External TTS service endpoint compatible with `POST /generate` (`{ "text": "..." }`)

## Configuration
1. Copy env:
```bash
cp .env.example .env
```
2. Update `.env` values:
- `GROQ_API_KEY`
- `TTS_BASE_URL` (your separate tts-kokoro API)
- `CATALOG_PATH` and `EMERGENCY_DIR` paths

## Start MediaMTX
Use the helper script:
```bash
./scripts/start-mediamtx.sh
```

This follows MediaMTX Docker kickoff usage from official docs:
[MediaMTX Install/Kickoff](https://mediamtx.org/docs/kickoff/install)

## Start RJ service
```bash
npm run build
npm run start
```

Then start orchestration:
```bash
curl -X POST http://127.0.0.1:3000/control/start
```

Check status:
```bash
curl http://127.0.0.1:3000/status
```

Dashboard snapshot:
```bash
curl http://127.0.0.1:3000/dashboard/snapshot
```

Playback URL:
- `http://127.0.0.1:8888/live/radio/index.m3u8`
- Low-latency monitor (WebRTC WHEP): `http://127.0.0.1:8889/live/radio/whep`

## Dashboard (Next.js)
1. Install dashboard deps:
```bash
npm --prefix dashboard install
```
2. Set dashboard env:
```bash
cp dashboard/.env.example dashboard/.env.local
```
3. Start dashboard:
```bash
npm run dashboard:dev
```

Open:
- `http://127.0.0.1:3001`

## Stop
```bash
curl -X POST http://127.0.0.1:3000/control/stop
./scripts/stop-mediamtx.sh
```

## Notes
- This is an MVP prototype and intentionally local/dev-focused.
- Ensure content usage complies with licensing and platform terms.
