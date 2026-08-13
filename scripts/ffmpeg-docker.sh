#!/bin/sh
set -eu

# Local development fallback using the FFmpeg build shipped in the agents image.
# Start the agent with TMPDIR=/private/tmp so renderer inputs share this mount.
exec docker run --rm \
  -v /private/tmp:/private/tmp \
  --entrypoint ffmpeg \
  dailies-agents-media:local "$@"
