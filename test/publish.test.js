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


test('publication blocks force-added credential paths even without recognizable text secrets', () => {
  const paths = ['.env.local', 'config/.env.production', '.env.backup', 'config/prod.env', 'config/prod.env.local',
    'prod-key.pem', 'keys/opaque.bin', 'backup/key.p12', 'secret.pfx', 'key.pkcs8', 'key.der', 'store.jks',
    '.kalshi/unknown', '.ssh/id_ecdsa', 'id_ed25519.pub', '.aws/config', 'secrets/opaque', 'credentials.json',
    'config/production-credentials.yaml', 'config/api-tokens.json', 'config/service-account-prod.json',
    'prod-key.txt', '.netrc', '.git-credentials', 'config/trading.local.json'];
  for (const path of paths) assert.ok(checkText(path, '').some(f => f.rule === 'credential file'), path);
  assert.equal(checkText('src/auth.js', '').length, 0);
  assert.equal(checkText('config/scan.json', '').length, 0);
});

test('encrypted private keys and npm auth are flagged without disclosing their values', () => {
  const marker = ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' ');
  assert.ok(checkText('notes.txt', marker).some(f => f.rule === 'private key'));
  const token = 'test-only-' + 'a'.repeat(20);
  const report = checkText('.npmrc', '//registry.npmjs.org/:_authToken=' + token);
  assert.ok(report.some(f => f.rule === 'package registry credential'));
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.equal(checkText('.npmrc', 'cache=.cache/npm\nfund=false\n').length, 0);
  assert.equal(checkText('.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n').length, 0);
});
