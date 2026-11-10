import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PROJECT_ROOT, projectPath } from '../src/files.js';

// 21 tiny day folders, one market each: a flat book and one seller who hits the resting bid.
function writeDays(root) {
  const days = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  for (const [i, day] of days.entries()) {
    const dir = projectPath(`${root}/${day}`), ticker = `KXA-D${i}-X`, close = Date.parse(day) + 86400000 - 1000;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/markets.jsonl`, JSON.stringify({ ticker, quotable: true, result: 'yes' }) + '\n');
    const rows = Array.from({ length: 20 }, (_, k) => ({ ticker, time: close - 6 * 3600000 + k * 60000, yesBid: 0.40, yesAsk: 0.46,
      yesBidSize: 1, yesAskSize: 1, close_time: new Date(close).toISOString(), fee_type: 'quadratic' }));
    writeFileSync(`${dir}/books.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(`${dir}/trades.jsonl`, JSON.stringify({ ticker, tradeId: 'a', time: rows[3].time + 30000, price: 0.40, count: 2, takerSide: 'no' }) + '\n');
  }
  return days;
}

test('the walk-forward skips the first two days, keeps the newest ten locked, and saves a model of every day it read', () => {
  const root = `work/walk-forward-test-${process.pid}`;
  try {
    const days = writeDays(root);
    const run = (...args) => {
      const result = spawnSync(process.execPath, ['scripts/kalshi-bandit.js', root, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return { report: JSON.parse(readFileSync(projectPath(`${root}/bandit-report.json`), 'utf8')), model: JSON.parse(readFileSync(projectPath(`${root}/bandit-model.json`), 'utf8')) };
    };
    const { report, model } = run();
    assert.deepEqual(report.summary.lockedDays, days.slice(-10));
    assert.deepEqual(report.days.map(d => d.day), days.slice(2, 11)); // a day is tested only once two earlier days exist
    assert.equal(report.summary.finalExamRun, false);
    assert.deepEqual(model.days, days.slice(0, 11)); // never trained on the exam
    assert.ok(report.summary.fixed.fills > 0);

    const exam = run('--final');
    assert.deepEqual(exam.report.days.map(d => d.day), days.slice(2));
    assert.ok(exam.report.days.slice(-10).every(d => d.locked));
  } finally {
    rmSync(projectPath(root), { recursive: true, force: true });
  }
});
