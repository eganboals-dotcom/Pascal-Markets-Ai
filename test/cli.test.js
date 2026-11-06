import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPath, PROJECT_ROOT } from '../src/files.js';

function command(...args) {
  return spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli.js'), ...args], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000
  });
}

test('project file paths reject traversal and resolve inside the installation', () => {
  assert.equal(projectPath('config/paper.json'), join(PROJECT_ROOT, 'config/paper.json'));
  assert.throws(() => projectPath('../outside.json'), /inside/);
  assert.throws(() => projectPath(''), /required/);
});

test('demo, training and both replay modes work through the CLI', () => {
  const demo = command('demo');
  assert.equal(demo.status, 0, demo.stderr);
  const report = JSON.parse(demo.stdout);
  assert.equal(report.synthetic, true);
  assert.equal(report.trainingGames, 8);
  assert.equal(report.evaluation.games, 4);
  assert.equal(report.sportsbookReplay.fills, 3);
  const model = JSON.parse(readFileSync(projectPath('data/demo/model.json'), 'utf8'));
  assert.equal(model.containsSyntheticData, true);

  const trained = command('train', 'data/demo/observations.jsonl', '2026-10-09T00:00:00Z', 'data/demo/retrained.json');
  assert.equal(trained.status, 0, trained.stderr);
  assert.deepEqual(JSON.parse(trained.stdout), report.evaluation);

  const bookReplay = command('replay', 'data/demo/holdout.jsonl', 'config/paper.json');
  assert.equal(bookReplay.status, 0, bookReplay.stderr);
  assert.equal(JSON.parse(bookReplay.stdout).fills, 3);
  const modelReplay = command('replay', 'data/demo/holdout.jsonl', 'data/demo/model-config.json', 'data/demo/model.json');
  assert.equal(modelReplay.status, 0, modelReplay.stderr);
  assert.equal(JSON.parse(modelReplay.stdout).fills, 2);
});

test('CLI fails clearly for unknown commands and paths outside the project', () => {
  assert.equal(command('unknown-command').status, 1);
  const invalid = command('train', 'unused.jsonl', '2026-10-09', '../outside-model.json');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /inside Pascal-Market-Ai/);
});
