#!/usr/bin/env bash
# GRANNY - Five Days to Get Out. Serves the folder and opens the browser.
cd "$(dirname "$0")"
echo "Serving on http://localhost:8099 ..."
( sleep 1; (command -v xdg-open >/dev/null && xdg-open http://localhost:8099/) || (command -v open >/dev/null && open http://localhost:8099/) ) &
if command -v python3 >/dev/null; then python3 -m http.server 8099
elif command -v python >/dev/null; then python -m http.server 8099
else npx --yes serve -l 8099 .; fi
