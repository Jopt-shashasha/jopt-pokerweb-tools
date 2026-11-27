#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if command -v python3.12 >/dev/null 2>&1; then
    PYTHON=python3.12
else
    PYTHON=python3
fi
exec "$PYTHON" install.py "$@"
