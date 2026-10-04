#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_dir"
umask 077

for directory in config certs; do
  if [[ -L "$directory" ]]; then
    printf 'Refusing symlink directory: %s\n' "$directory" >&2
    exit 1
  fi
  mkdir -p -- "$directory"
  chmod 700 -- "$directory"
done

printf 'Install the existing danmu.dusheng.lol certificate as certs/fullchain.pem and certs/privkey.pem.\n'
printf 'Then run: python3 scripts/configure-cdn-origin.py --bot-config /path/to/Bot/config.json\n'
printf 'Then validate with: docker compose -f compose.yaml -f compose.cdn.yaml run --rm --no-deps cdn-origin nginx -t\n'
