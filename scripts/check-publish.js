import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/files.js';

const checks = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API token', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['personal Windows path', /\b[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>\\/]+/i],
  ['personal Unix path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['credential in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/i],
  ['hardcoded credential', /\b(?:api[_-]?key|access[_-]?token|private[_-]?key|password|secret)\b\s*[=:]\s*["'][A-Za-z0-9_+/=-]{16,}["']/i],
  ['wallet private key assignment', /(?:private[_-]?key|wallet[_-]?key)\s*[=:]\s*["']?(?:0x)?[a-f0-9]{64}\b/i],
  ['seed phrase assignment', /(?:seed[_-]?phrase|mnemonic)\s*[=:]\s*["'](?:[a-z]+\s+){11,}[a-z]+["']/i]
];

export function checkText(path, text) {
  const findings = [];
  // Ignore rules do not protect force-added files or files already tracked in Git.
  const credentialPath = [
    /(?:^|\/)(?:\.env(?:[.-].*)?|[^/]+\.env(?:\..*)?|\.envrc)$/i,
    /\.(?:pem|key|p8|pkcs8|p12|pfx|der|jks|keystore|secrets?)$/i,
    /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$/i,
    /(?:^|\/)(?:\.kalshi|\.ssh|\.aws|\.direnv|keys|secrets|credentials)(?:\/|$)/i,
    /(?:^|\/)(?:tokens|\.netrc|\.git-credentials|\.pypirc|\.dockercfg)$/i,
    /(?:^|\/)[^/]*(?:credential|secret|token)[^/]*\.(?:json|ya?ml|toml|ini|txt)$/i,
    /(?:^|\/)[^/]*service[-_]account[^/]*\.json$/i,
    /(?:^|\/)[^/]*[-_]key\.txt$/i,
    /^config\/[^/]+\.local\.json$/i
  ].some(pattern => pattern.test(path));
  if (credentialPath && path !== '.env.example') findings.push({ path, line: 0, rule: 'credential file' });
  if (/^(?:data|models|outputs|work|\.cache|node_modules)\//.test(path)) findings.push({ path, line: 0, rule: 'local artifact directory' });
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/(?:^|\/)\.npmrc$/i.test(path) && /^\s*(?:\/\/[^\r\n]*:)?(?:_authToken|_auth|_password)\s*=\s*(?!\$\{[A-Z0-9_]+\}\s*$)\S+/i.test(line)) {
      findings.push({ path, line: index + 1, rule: 'package registry credential' });
    }
    for (const [rule, pattern] of checks) {
      if (pattern.test(line)) findings.push({ path, line: index + 1, rule });
    }
    const emails = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    if (emails.some(email => !email.endsWith('@example.com') && !email.endsWith('@users.noreply.github.com'))) {
      findings.push({ path, line: index + 1, rule: 'email address requires review' });
    }
    if (path === '.env.example' && /^\s*[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/.test(line)) {
      findings.push({ path, line: index + 1, rule: 'populated example credential' });
    }
  });
  return findings;
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Git inspection failed. Publication check cannot proceed.');
  return result.stdout;
}

export function checkPublication() {
  const findings = [];
  let scanned = 0;
  // Scan the staged snapshot and every reachable commit, including deleted files.
  const revisions = git('rev-list', '--all').trim().split('\n').filter(Boolean);
  const inspected = new Set();
  const snapshots = [{ revision: 'index', entries: git('ls-files', '--stage', '-z') },
    ...revisions.map(revision => ({ revision, entries: git('ls-tree', '-r', '-z', revision) }))];
  for (const { revision, entries } of snapshots) {
    for (const entry of entries.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const path = entry.slice(tab + 1);
      const fields = entry.slice(0, tab).split(' ');
      const sha = revision === 'index' ? fields[1] : fields[2];
      const identity = `${path}:${sha}`;
      if (inspected.has(identity)) continue;
      inspected.add(identity);
      scanned++;
      const content = git('cat-file', 'blob', sha);
      findings.push(...checkText(path, content).map(finding => ({ ...finding, revision })));
    }
  }
  return { scanned, commits: revisions.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = checkPublication();
    console.log(JSON.stringify(report, null, 2));
    if (report.findings.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
