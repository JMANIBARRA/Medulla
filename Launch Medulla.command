#!/bin/bash
# Double-click this file to launch Medulla with YouTube playback working.
# (Opening medulla.html directly makes YouTube reject video embeds — it only
# allows them from a real http:// page, not a local file:// one.)
cd "$(dirname "$0")"
PORT=8934
open "http://localhost:$PORT/medulla.html"
python3 -m http.server "$PORT"
