#!/usr/bin/env python3
"""Bounded native deployment storage checks; never deletes runtime data/backups."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import tarfile

GIB = 1024 ** 3
RESERVE = 2 * GIB
DOWNLOAD_LIMIT = 2 * GIB


def require_space(path, needed, reserve=RESERVE):
    # f_bavail excludes root's reserved blocks: APIs run as node, not root.
    while not path.exists():
        path = path.parent
    stat = os.statvfs(path)
    available = stat.f_bavail * stat.f_frsize
    if available < needed + reserve:
        raise RuntimeError(f'Insufficient deployment space on {path}: '
                           f'{available // 1024**2} MiB available; '
                           f'{(needed + reserve) // 1024**2} MiB required including reserve. '
                           'Free space or expand the disk before retrying; services were not stopped.')


def snapshot_bytes(data):
    return sum(p.stat().st_size for area in ('engine', 'product')
               for name in ('nest.sqlite', 'nest.sqlite-wal')
               if (p := data / area / name).is_file())


def check_install(artifact, root, data):
    with tarfile.open(artifact) as archive:
        # Account for filesystem allocation and inode/directory overhead too.
        expanded = sum(((max(m.size, 1) + 4095) // 4096) * 4096 for m in archive)
    snapshots = snapshot_bytes(data)
    # Snapshot plus room for migration/rollback, tool downloads and first-host swap.
    require_space(root, expanded + 2 * snapshots + 3 * GIB)
    require_space(data, snapshots)


def prune_releases(root, active, keep=3):
    releases = root / 'releases'
    if not releases.exists():
        return []
    protected = {active.resolve()}
    # Retain releases paired with the three newest host snapshots, regardless of
    # directory timestamps. Older DB backups stay, but may need artifact download.
    backups = sorted((root / 'backups').glob('host-*'), key=lambda p: p.name, reverse=True)
    for backup in backups[:keep]:
        pointer = backup / 'release'
        if pointer.is_file():
            protected.add(Path(pointer.read_text().strip()).resolve())
    candidates = []
    for release in releases.iterdir():
        if release.is_symlink() or release.is_mount() or not release.is_dir() or not re.fullmatch('[a-f0-9]{40}', release.name):
            continue
        try:
            manifest = json.loads((release / 'nest-release.json').read_text())
            if manifest.get('commit') != release.name or not (release / '.artifact-sha256').is_file():
                continue
            # Never remove a legacy directory containing real runtime state.
            if any((release / name).exists() and not (release / name).is_symlink()
                   for name in ('.nest-data', '.nest-product', 'files', '.env')):
                continue
        except (OSError, ValueError):
            continue
        candidates.append(release)
    candidates.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
    protected.update(p.resolve() for p in candidates[:keep])
    removed = []
    for release in candidates:
        if release.resolve() in protected:
            continue
        # shutil.rmtree does not follow runtime symlinks; refuse nested mounts.
        if any(os.path.ismount(Path(base) / name) for base, dirs, _ in os.walk(release)
               for name in dirs if not (Path(base) / name).is_symlink()):
            continue
        shutil.rmtree(release)
        removed.append(release.name)
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['download', 'install', 'snapshot', 'prune'])
    parser.add_argument('--artifact', type=Path)
    parser.add_argument('--root', type=Path, default=Path('/opt/nest'))
    parser.add_argument('--data', type=Path, default=Path('/var/lib/nest'))
    args = parser.parse_args()
    if args.action == 'download':
        require_space(args.root, DOWNLOAD_LIMIT)
    elif args.action == 'install':
        if not args.artifact:
            parser.error('--artifact is required')
        check_install(args.artifact, args.root, args.data)
    elif args.action == 'snapshot':
        require_space(args.root, 2 * snapshot_bytes(args.data))
        require_space(args.data, snapshot_bytes(args.data))
    else:
        print(json.dumps({'removedReleases': prune_releases(args.root, Path('/app'))}))


if __name__ == '__main__':
    main()
