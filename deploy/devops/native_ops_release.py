"""Stage a release without executing checkout code or trusting a checksum sidecar."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
from typing import BinaryIO, Protocol

from native_ops_v2 import DeployRequest, Release, SHA, DIGEST

LIMIT = 2 * 1024 ** 3
MEMBER_LIMIT = 1024 * 1024
MEMBERS = {'nest-release.json', 'scripts/install-host.sh', 'deploy/native/storage.py',
           'deploy/native/versions.env', 'deploy/native/activation.py'}


class ReleaseRejected(RuntimeError):
    """A release failed preflight without activating."""


class ReleaseSource(Protocol):
    def open_asset(self, artifact: Release) -> BinaryIO: ...
    def verify_provenance(self, artifact: Release, path: Path) -> None: ...
    def is_ancestor(self, active_commit: str, target_commit: str) -> bool: ...


@dataclass(frozen=True)
class ReleaseIdentity:
    commit: str
    sha256: str


@dataclass(frozen=True)
class PreparedRelease:
    identity: ReleaseIdentity
    artifact: Path
    installer: Path


def require_space(directory: Path) -> None:
    info = os.statvfs(directory)
    if info.f_bavail * info.f_frsize < 2 * LIMIT + len(MEMBERS) * MEMBER_LIMIT:
        raise ReleaseRejected('insufficient_space')


def read_active(config: Path, app: Path, releases: Path) -> ReleaseIdentity:
    try:
        commit = json.loads(config.read_text())['commit']
        if not re.fullmatch(SHA, commit) or not app.is_symlink():
            raise ReleaseRejected('active_release_unknown')
        target = releases.resolve(strict=True) / commit
        if app.resolve(strict=True) != target or target.is_symlink():
            raise ReleaseRejected('active_release_unknown')
        receipt = target / '.artifact-sha256'
        if not receipt.is_file() or receipt.is_symlink():
            raise ReleaseRejected('active_release_unknown')
        digest = receipt.read_text().strip()
        if not re.fullmatch(DIGEST, digest):
            raise ReleaseRejected('active_release_unknown')
        return ReleaseIdentity(commit, digest)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReleaseRejected('active_release_unknown') from error


def prepare_release(request: DeployRequest, active: ReleaseIdentity, source: ReleaseSource,
                    stage: Path) -> PreparedRelease | None:
    identity = ReleaseIdentity(request.release.commit, request.release.sha256)
    if identity.commit == active.commit:
        if identity != active:
            raise ReleaseRejected('active_digest_mismatch')
        return None
    try:
        if source.is_ancestor(active.commit, identity.commit) is not True:
            raise ReleaseRejected('target_not_forward')
        info = stage.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ReleaseRejected('unsafe_staging')
        require_space(stage)
        artifact = stage / request.release.asset
        digest = hashlib.sha256()
        length = 0
        with source.open_asset(request.release) as incoming, artifact.open('xb') as out:
            for chunk in iter(lambda: incoming.read(MEMBER_LIMIT), b''):
                length += len(chunk)
                if length > LIMIT:
                    raise ReleaseRejected('artifact_too_large')
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != identity.sha256:
            raise ReleaseRejected('digest_mismatch')
        source.verify_provenance(request.release, artifact)
        selected = {}
        with tarfile.open(artifact, 'r|gz') as bundle:
            for member in bundle:
                if member.name not in MEMBERS:
                    continue
                if member.name in selected or not member.isreg() or not 0 < member.size <= MEMBER_LIMIT:
                    raise ReleaseRejected('invalid_installer_members')
                with bundle.extractfile(member) as file:
                    selected[member.name] = file.read(MEMBER_LIMIT + 1)
        if selected.keys() != MEMBERS:
            raise ReleaseRejected('missing_installer_members')
        manifest = json.loads(selected['nest-release.json'])
        if (not isinstance(manifest, dict) or manifest.get('commit') != identity.commit
                or manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64'
                or manifest.get('format') != 1 or manifest.get('activationProtocol') != 2):
            raise ReleaseRejected('incompatible_release')
        tree = stage / 'tree'
        tree.mkdir(mode=0o700)
        for name, content in selected.items():
            path = tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as file:
                file.write(content)
        return PreparedRelease(identity, artifact, tree / 'scripts/install-host.sh')
    except ReleaseRejected:
        raise
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
        raise ReleaseRejected('release_preflight_failed') from error
