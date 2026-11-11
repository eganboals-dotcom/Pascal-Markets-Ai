// Downloads Jon Becker's public prediction-market dataset (every Kalshi and Polymarket market and trade with size and taker side,
// to 2026-02-05; github.com/Jon-Becker/prediction-market-analysis, MIT) into data/becker/ and unpacks it. It waits until the Kalshi
// history download is no longer running, so the two never share the connection. curl resumes a partial file, so a rerun continues.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadState } from '../src/history.js';
import { projectPath } from '../src/files.js';

const URL = 'https://s3.jbecker.dev/data.tar.zst', BYTES = 36020641508, WAIT_MS = 5 * 60000; // size from the server, Nov 11
const dir = projectPath('data/becker'), archive = `${dir}/data.tar.zst`, log = projectPath('data/history/backfill.log');
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }); if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status ?? r.signal}`); };

while (existsSync(log) && downloadState(readFileSync(log, 'utf8'), statSync(log).mtimeMs) === 'running') {
  say({ waiting: 'Kalshi history download' }); await sleep(WAIT_MS);
}
mkdirSync(dir, { recursive: true });
if (!existsSync(`${dir}/unpacked`)) {
  if (!existsSync(archive) || statSync(archive).size !== BYTES) {
    say({ downloading: URL });
    run('curl.exe', ['-L', '-sS', '-A', 'pascal-markets-research', '--retry', '10', '--retry-all-errors', '-C', '-', '-o', archive, URL]);
  }
  if (statSync(archive).size !== BYTES) throw new Error(`Archive is ${statSync(archive).size} bytes, expected ${BYTES}; rerun to resume`);
  say({ unpacking: archive });
  run('tar.exe', ['-xf', archive, '-C', dir]);
  writeFileSync(`${dir}/unpacked`, new Date().toISOString() + '\n');
}
say({ done: dir });
