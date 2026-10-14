#!/bin/sh
set -eu
if [ "${1:-}" = setup ]; then
  shift
  exec node /app/src/setup.ts "$@"
fi
if [ "$#" -eq 0 ]; then
  exec node /app/src/main.ts
fi
exec "$@"
