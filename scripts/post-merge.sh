#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
python3 -m pip install --break-system-packages --quiet curl_cffi 2>/dev/null || true
