#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4173}"
DIR="$(cd "$(dirname "$0")" && pwd)"

IP="$(
  route get default 2>/dev/null \
    | awk '/interface:/{print $2}' \
    | head -n 1 \
    | xargs -I{} ipconfig getifaddr {} 2>/dev/null \
    || true
)"

if [ -z "$IP" ]; then
  IP="$(ifconfig | awk '/inet / && $2 !~ /^127\\./ { print $2; exit }')"
fi

cd "$DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
    NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
  elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js was not found."
  echo "Install Node.js, or run with NODE_BIN=/path/to/node ./start-mobile-server.sh"
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "BerlinNote is already running on port ${PORT}."
  echo ""
  echo "Open:"
  echo "  http://localhost:${PORT}/?v=server-import-5"
  if [ -n "$IP" ]; then
    echo "  http://${IP}:${PORT}/?v=server-import-5"
  fi
  echo ""
  echo "If you want to restart it, stop the old terminal with Ctrl+C first."
  echo ""
  exit 0
fi

echo ""
echo "BerlinNote demo is running."
echo ""
echo "Computer:"
echo "  http://localhost:${PORT}/?demo=sample.epub"
echo ""
if [ -n "$IP" ]; then
  echo "iPhone / iPad on the same Wi-Fi:"
  echo "  http://${IP}:${PORT}/?demo=sample.epub"
  echo ""
else
  echo "Could not detect a LAN IP automatically."
  echo "Open System Settings > Wi-Fi > Details to find your Mac IP address."
  echo ""
fi
echo "Press Ctrl+C to stop."
echo ""

"$NODE_BIN" server.mjs "$PORT"
