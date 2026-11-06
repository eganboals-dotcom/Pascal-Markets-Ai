# Project boundary

The user requires all project work to stay inside this repository folder, Pascal-Market-Ai. Ask for explicit permission before accessing or changing files outside it. Keep dependencies, downloads, temporary files, browser profiles, caches, and generated artifacts here.

Use `.cache/` for tool caches, `work/` for scratch files, `data/` for recordings and datasets, `models/` for trained artifacts, and `outputs/` for browser screenshots and deliverables. Use the project path helpers for application file access.

Run `node --test` after code changes. Run `node scripts/browser-smoke.js` after dashboard changes when the local browser dependency is installed. Use `node scripts/install-browser.js` to install browser test assets within this folder.

Keep synthetic demonstrations labeled. Live execution requires a separately reviewed implementation, verified venue eligibility, risk limits, and explicit approval to use funds.

Before every push, inspect all proposed files and commit metadata for personal information and secrets, and run `node scripts/check-publish.js`. Resolve every finding before publication. The local pre-push hook enforces common credential and personal-path checks. Automated scanning complements manual review and cannot establish the absence of every kind of sensitive information. Never include matched secret values in logs or reports.
