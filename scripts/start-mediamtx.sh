#!/usr/bin/env bash
set -euo pipefail

docker run --rm -d \
  --name mediamtx \
  -p 1935:1935 \
  -p 8888:8888 \
  -p 8889:8889 \
  -p 8890:8890/udp \
  -p 8554:8554 \
  bluenviron/mediamtx:1

echo "MediaMTX started:"
echo "  RTMP publish: rtmp://127.0.0.1:1935/live/radio"
echo "  HLS playback: http://127.0.0.1:8888/live/radio/index.m3u8"
