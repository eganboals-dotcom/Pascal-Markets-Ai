import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { projectPath, PROJECT_ROOT } from '../src/files.js';

mkdirSync(projectPath('.cache/tmp'), { recursive: true });
const result = spawnSync(process.execPath, [projectPath('node_modules/playwright/cli.js'), 'install', 'chromium'], {
  cwd: PROJECT_ROOT, stdio: 'inherit',
  env: { ...process.env, TEMP: projectPath('.cache/tmp'), TMP: projectPath('.cache/tmp'),
    PLAYWRIGHT_BROWSERS_PATH: projectPath('.cache/ms-playwright') }
});
process.exitCode = result.status ?? 1;
