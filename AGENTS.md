# Project boundary

The user requires all project work to stay inside this repository folder, Pascal-Markets-Ai. Ask for explicit permission before accessing or changing files outside it. Keep dependencies, downloads, temporary files, browser profiles, caches, and generated artifacts here.

Use `.cache/` for tool caches, `work/` for scratch files, `data/` for local recordings, and `outputs/` for screenshots and deliverables. Use the project path helpers for application file access.

Run `node --test` after code changes.

This is a research scanner. It reads public market data only. Placing orders requires a separately reviewed implementation, verified venue eligibility, risk limits, and explicit approval to use funds. Cross-venue pairs in `config/pairs.json` are added only after both venues' settlement rules have been read and agree.

Before every push, inspect all proposed files and commit metadata for personal information and secrets, and run `node scripts/check-publish.js`. Resolve every finding before publication. The local pre-push hook enforces common credential and personal-path checks. Automated scanning complements manual review and cannot establish the absence of every kind of sensitive information. Never include matched secret values in logs or reports.

Any future live trading must require `verified && reviewed`. Scanner and dry-run eligibility use `verified`; reviewed series are listed in `verified.reviewedSeries`.
