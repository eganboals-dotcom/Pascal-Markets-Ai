// Downloads Jon Becker's public prediction-market dataset (every Kalshi and Polymarket market and trade with size and taker side,
// to 2026-02-05; github.com/Jon-Becker/prediction-market-analysis, MIT) into data/becker/ and unpacks it. It waits until the Kalshi
// history download is no longer running, so the two never share the connection. curl resumes a partial file, so a rerun continues.
// Safety, before anything is trusted: the archive is listed first and only plain data files (.parquet, .json, .csv, .md, .txt) under
// data/kalshi/ or data/polymarket/ are unpacked; links, programs, absolute paths and ".." are never written. Every Parquet file
// must start and end with the Parquet marker (others are deleted). Windows Defender scans the folder, and scripts/becker-check.py
// compares a sample with Kalshi's own API. The results go to data/becker/safety-report.json; the data counts as usable only once
// data/becker/verified exists. --self-test checks the entry filter and exits.
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadState } from '../src/history.js';
import { projectPath } from '../src/files.js';

const URL = 'https://s3.jbecker.dev/data.tar.zst', BYTES = 36020641508, WAIT_MS = 5 * 60000; // size from the server, Nov 11
const dir = projectPath('data/becker'), archive = `${dir}/data.tar.zst`, log = projectPath('data/history/backfill.log');
const DEFENDER = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe', PYTHON = projectPath('.venv/Scripts/python.exe');
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const lines = text => String(text ?? '').split(/\r?\n/).filter(Boolean);
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }); if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status ?? r.signal}`); };
const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status ?? r.signal}: ${String(r.stderr).slice(0, 500)}`);
  return lines(r.stdout);
};

// A tar entry is unpacked only when it is a plain file ('-' in the listing) with a data extension under data/kalshi/ or data/polymarket/.
const safeEntry = (type, name) => type === '-' && /^(\.\/)?data\/(kalshi|polymarket)\/[A-Za-z0-9_.=\-/]+\.(parquet|json|csv|md|txt)$/i.test(name)
  && !name.split('/').some(part => part === '..' || part.startsWith('._'));
const isParquet = path => {
  const fd = openSync(path, 'r'), size = statSync(path).size, head = Buffer.alloc(4), tail = Buffer.alloc(4);
  try { readSync(fd, head, 0, 4, 0); readSync(fd, tail, 0, 4, Math.max(0, size - 4)); } finally { closeSync(fd); }
  return size >= 12 && head.toString('latin1') === 'PAR1' && tail.toString('latin1') === 'PAR1';
};
const filesUnder = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(`${path}/${e.name}`) : [`${path}/${e.name}`]);

if (process.argv.includes('--self-test')) {
  assert.ok(safeEntry('-', 'data/kalshi/trades/trades_0001.parquet'));
  assert.ok(safeEntry('-', './data/polymarket/markets/part=1/x.json'));
  for (const [type, name] of [['-', 'data/kalshi/run.exe'], ['-', 'data/kalshi/../../evil.parquet'], ['l', 'data/kalshi/x.parquet'],
    ['h', 'data/kalshi/x.parquet'], ['-', '/data/kalshi/x.parquet'], ['-', 'C:/data/kalshi/x.parquet'], ['-', 'data/kalshi/._x.parquet'],
    ['-', 'data/other/x.parquet'], ['-', 'data\\kalshi\\x.parquet'], ['-', 'data/kalshi/x.parquet.lnk']]) assert.ok(!safeEntry(type, name), name);
  console.log('self-test passed');
  process.exit(0);
}

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
  say({ listing: archive });
  const names = capture('tar.exe', ['-tf', archive]), long = capture('tar.exe', ['-tvf', archive]);
  if (names.length !== long.length) throw new Error(`Archive listing disagrees (${names.length} names, ${long.length} entries); not unpacked`);
  const safe = [], skipped = [];
  names.forEach((name, i) => { const type = long[i][0]; if (safeEntry(type, name)) safe.push(name); else if (type !== 'd') skipped.push(`${type} ${name}`); });
  writeFileSync(`${dir}/safe-files.txt`, safe.join('\n') + '\n');
  writeFileSync(`${dir}/skipped-files.txt`, skipped.join('\n') + '\n');
  say({ unpacking: archive, files: safe.length, skipped: skipped.length });
  run('tar.exe', ['-xf', archive, '-C', dir, '-T', `${dir}/safe-files.txt`]);
  writeFileSync(`${dir}/unpacked`, new Date().toISOString() + '\n');
}
if (!existsSync(`${dir}/verified`)) {
  const data = `${dir}/data`, badParquet = [];
  for (const path of filesUnder(data).filter(p => p.endsWith('.parquet'))) if (!isParquet(path)) { badParquet.push(path); unlinkSync(path); }
  say({ scanning: data });
  const scan = spawnSync(DEFENDER, ['-Scan', '-ScanType', '3', '-File', data], { encoding: 'utf8', windowsHide: true });
  const defender = { exit: scan.status, output: lines(scan.stdout).slice(-5) };
  say({ checking: 'sample against Kalshi' });
  const check = spawnSync(PYTHON, ['-I', projectPath('scripts/becker-check.py'), dir], { encoding: 'utf8', windowsHide: true });
  const skipped = existsSync(`${dir}/skipped-files.txt`) ? lines(readFileSync(`${dir}/skipped-files.txt`, 'utf8')) : [];
  const report = { time: new Date().toISOString(), skipped, badParquet, defender,
    check: { exit: check.status, output: String(check.stdout ?? '').trim(), errors: String(check.stderr ?? '').trim().slice(-2000) } };
  writeFileSync(`${dir}/safety-report.json`, JSON.stringify(report, null, 2) + '\n');
  // Defender exits 0 when nothing was found and 2 when it found (and removed) a threat; the check exits 0 when the sample matched.
  if (defender.exit !== 0 || check.status !== 0) throw new Error(`Not verified: Defender exit ${defender.exit}, check exit ${check.status}; see ${dir}/safety-report.json`);
  writeFileSync(`${dir}/verified`, new Date().toISOString() + '\n');
}
say({ done: dir });
