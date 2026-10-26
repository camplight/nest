import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nest-native-links-')); roots.push(root);
  const engine = join(root, 'persistent-engine'), files = join(root, 'persistent-files'), old = join(root, 'old-release');
  mkdirSync(join(engine, 'engine', 'skills'), {recursive: true}); mkdirSync(files); mkdirSync(old);
  writeFileSync(join(files, 'upload.txt'), 'preserved upload'); writeFileSync(join(engine, 'identity'), 'same runner');
  symlinkSync(engine, join(old, '.nest-data'), 'junction'); symlinkSync(files, join(old, 'files'), 'junction');
  return {root, engine, files, old};
}
function configure(f: ReturnType<typeof fixture>) {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import {configureOrgOpsEnv} from './scripts/orgops-env.ts'; configureOrgOpsEnv();"], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {PATH: process.env.PATH, NEST_ENGINE_DATA_DIR: f.engine, NEST_FILES_DIR: f.files, NEST_RUNNER_ID_FILE: join(f.engine, 'runner-id')},
  });
}

describe('persistent native runtime links', () => {
  it('uploads and engine aliases survive retiring the release they previously referenced', () => {
    const f = fixture();
    const project = join(f.engine, 'engine');
    symlinkSync(join(f.old, '.nest-data'), join(project, '.nest-data'), 'junction');
    symlinkSync(join(f.old, '.nest-data'), join(project, '.orgops-data'), 'junction');
    symlinkSync(join(f.old, 'files'), join(project, 'files'), 'junction');
    configure(f); rmSync(f.old, {recursive: true}); configure(f);
    expect(readFileSync(join(project, 'files/upload.txt'), 'utf8')).toBe('preserved upload');
    expect(readFileSync(join(project, '.nest-data/identity'), 'utf8')).toBe('same runner');
    expect(readFileSync(join(project, '.orgops-data/identity'), 'utf8')).toBe('same runner');
    expect(readlinkSync(join(project, 'files'))).toBe(f.files);
  });
  it('preserves existing real directories and their contents', () => {
    const f = fixture();
    const existing = join(f.engine, 'engine', 'files'); mkdirSync(existing); writeFileSync(join(existing, 'kept'), 'user data');
    configure(f);
    expect(readFileSync(join(existing, 'kept'), 'utf8')).toBe('user data');
  });
});
