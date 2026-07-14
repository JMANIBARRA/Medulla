#!/bin/bash
# Double-click this file to update Medulla from GitHub and launch it locally, with YouTube
# playback working. (Opening medulla.html directly makes YouTube reject video embeds — it only
# allows them from a real http:// page, not a local file:// one — and cloud sign-in/most widgets'
# live data feeds don't work from file:// at all either.)
cd "$(dirname "$0")"
PORT=8934

# pull the latest version from GitHub first, so every double-click is always current — if this
# folder isn't a real git clone (or there's no network, or something's diverged locally), this
# just fails quietly and we carry on with whatever's already on disk instead of blocking launch.
if [ -d .git ]; then
  echo "Checking for updates..."
  git pull --ff-only 2>&1 || echo "(couldn't auto-update — continuing with the version already on disk)"
fi

# if a server's already running on this port (e.g. you double-clicked this before and left that
# window open, or launched it twice), don't try to start a second one on the same port — just
# open the browser to what's already there.
if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  sleep 1
  echo "Medulla is running at http://localhost:$PORT/medulla.html"
  echo "Leave this window open to keep it running — closing it (or Ctrl+C) stops the server."
  open "http://localhost:$PORT/medulla.html"
  wait
else
  echo "Medulla is already running at http://localhost:$PORT/medulla.html"
  open "http://localhost:$PORT/medulla.html"
fi
