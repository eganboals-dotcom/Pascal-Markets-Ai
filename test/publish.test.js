import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from '../scripts/check-publish.js';

test('publication scan detects credentials without returning their values', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const report = checkText('source.js', token);
  assert.equal(report[0].rule, 'GitHub token');
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.ok(checkText('.env', 'KEY=').length);
  assert.ok(checkText('.env.example', 'ODDS_API_KEY=' + 'placeholder').length);
  assert.equal(checkText('.env.example', 'ODDS_API_KEY=\n').length, 0);
});

test('publication scan catches personal paths and email addresses', () => {
  const windowsPath = 'C:' + '\\Users\\' + 'someone\\project';
  assert.ok(checkText('notes.md', windowsPath).some(finding => finding.rule === 'personal Windows path'));
  const email = 'private.person' + '@' + 'mail.test';
  assert.ok(checkText('notes.md', email).some(finding => finding.rule.includes('email')));
  assert.equal(checkText('source.js', 'const path = "data/demo";').length, 0);
});
