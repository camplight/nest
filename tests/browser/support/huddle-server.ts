import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// Product CI already uses Docker. Keep the browser media test reproducible with
// the same pinned SFU as native production; no model/provider credentials.
export async function huddleTestServer() {
  if (process.env.NEST_HUDDLE_TEST_URL) return {url: process.env.NEST_HUDDLE_TEST_URL, close() {}};
  if (!process.env.CI || process.platform !== 'linux') return {url: undefined, close() {}};
  const versions = readFileSync(new URL('../../../deploy/native/versions.env', import.meta.url), 'utf8');
  const version = versions.match(/^LIVEKIT_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  if (!version) throw Error('Pinned LiveKit version is missing');
  const name = `nest-huddle-test-${process.pid}`;
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '--memory=256m', '--cpus=1',
    '-p', '127.0.0.1:17880:7880', '-p', '127.0.0.1:7881:7881', '-p', '127.0.0.1:7882:7882/udp',
    `livekit/livekit-server:v${version}`, '--dev', '--bind', '0.0.0.0', '--node-ip', '127.0.0.1',
    '--keys', 'huddle-test: huddle-test-secret-for-disposable-fixtures'], {stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000});
  const close = () => {execFileSync('docker', ['stop', '-t', '2', name], {stdio: 'ignore', timeout: 10_000});};
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch('http://127.0.0.1:17880', {signal: AbortSignal.timeout(1000)}).then(r => r.ok).catch(() => false)) return {url: 'ws://127.0.0.1:17880', close};
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Disposable LiveKit did not become ready');
  } catch (error) {close(); throw error;}
}
