#!/bin/sh
set -eu
home=/app/.nest-data/codex-home
exec "$home/tools/bin/ssh" -T -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$home/devops/known_hosts" \
  -i "$home/devops/id_ed25519" root@172.105.78.86 "$@"
