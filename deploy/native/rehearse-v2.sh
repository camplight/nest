#!/usr/bin/env bash
# Disposable Ubuntu 24.04 x64 VM only; run after the baseline rehearsal.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
usage() { printf 'Usage: %s <baseline-artifact> | --prepare-reboot <failed-restore|interrupted-before-cutoff> | --check-reboot\n' "$0"; }
case ${1:-} in
  -h|--help) usage; exit 0;;
  --prepare-reboot) [[ $# == 2 ]] || { usage >&2; exit 2; }; mode=prepare-reboot; shift;;
  --check-reboot) [[ $# == 1 ]] || { usage >&2; exit 2; }; mode=check-reboot; shift;;
  -*) usage >&2; exit 2;;
  *) [[ $# == 1 ]] || { usage >&2; exit 2; }; mode=upgrade;;
esac
exec /usr/bin/python3 -I "$here/rehearse-v2.py" "$mode" "$@"
