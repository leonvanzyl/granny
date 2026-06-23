#!/usr/bin/env bash
# GRANNY - Five Days to Get Out. Installs deps if needed, runs the Vite dev server.
cd "$(dirname "$0")"
if ! command -v npm >/dev/null; then
  echo "Node.js / npm not found. Install Node 18+ from https://nodejs.org and re-run."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)..."
  npm install
fi
echo "Starting Vite dev server on http://localhost:8099 ..."
( sleep 2; (command -v xdg-open >/dev/null && xdg-open http://localhost:8099/) || (command -v open >/dev/null && open http://localhost:8099/) ) &
npm run dev
