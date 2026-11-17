#!/usr/bin/env bash
# Run the OpenPong relay server. Works on Windows (via Git Bash / WSL) and macOS.
#
# Usage:
#   ./run.sh              # start the relay on 0.0.0.0:8765
#   RELAY_PORT=9000 ./run.sh
#
# On first run this creates a venv next to this script and installs
# requirements.txt into it. Subsequent runs reuse the venv.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VENV_DIR=".venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "relay: creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# Windows venvs put the interpreter in Scripts/, POSIX venvs in bin/.
if [ -f "$VENV_DIR/Scripts/python.exe" ]; then
  PY="$VENV_DIR/Scripts/python.exe"
else
  PY="$VENV_DIR/bin/python"
fi

"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q -r requirements.txt

if [ -z "${RELAY_OPERATOR_TOKEN:-}" ]; then
  echo "relay: WARNING RELAY_OPERATOR_TOKEN is unset — every control endpoint will refuse (503)."
  echo "relay: set it to a random 32+ character secret, e.g. openssl rand -hex 32"
fi

exec "$PY" server.py
