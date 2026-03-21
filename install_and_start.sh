#!/usr/bin/env bash
# Civilization Clash - Install dependencies and start servers
# Usage: bash install_and_start.sh [server flags...]
# Example: bash install_and_start.sh --tournament --no-fog

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check Node.js version
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed. Download it from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js 22+ required (you have v$(node -v))"
  echo "Download the latest version from https://nodejs.org/"
  exit 1
fi

# Install server dependencies
echo "Installing server dependencies..."
cd server && npm install --silent && cd ..

cleanup() {
  echo ""
  echo "Shutting down..."
  # Kill anything on ports 8080 and 3000
  if command -v lsof &> /dev/null; then
    lsof -ti:8080 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
  elif command -v fuser &> /dev/null; then
    fuser -k 8080/tcp 2>/dev/null || true
    fuser -k 3000/tcp 2>/dev/null || true
  else
    kill $SERVER_PID $FRONTEND_PID 2>/dev/null || true
  fi
  exit 0
}

trap cleanup INT TERM

# Start game server (WebSocket on :8080)
node server/server.js "$@" &
SERVER_PID=$!

# Start frontend file server (HTTP on :3000)
node visuals/serve.js &
FRONTEND_PID=$!

echo ""
echo "=== Civilization Clash ==="
echo "Game server:  ws://localhost:8080"
echo "Frontend:     http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""

wait
