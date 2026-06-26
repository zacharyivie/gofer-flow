#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
uv run --extra xlsx pyinstaller --clean --noconfirm gof.spec
