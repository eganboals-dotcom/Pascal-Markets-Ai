# Pascal Markets

A research scanner for mispricing and arbitrage on Kalshi. It reads Kalshi's public REST API, prices every basket that pays out in all outcomes, and records how long each profitable one lasts. It places no orders and needs no account or API key.

## What it looks for

- **No baskets on exclusive events.** At most one outcome of a mutually exclusive event wins, so buying No on all n outcomes pays at least n − 1. Buying Yes on every outcome is not treated as an arbitrage: Kalshi's outcomes need not be exhaustive.
- **Strike-ladder contradictions.** For "above X" markets on the same underlying, Yes at a lower strike plus No at a higher strike always pays 1. "Below X" ladders mirror this. Rungs count as the same underlying only when their settlement rules read the same once the numbers are removed, and rungs must close at the same time, and only one-sided strikes qualify (Kalshi tags some "exactly N" buckets as "less").
- **Cross-venue gaps with Polymarket.** For each reviewed pair in `config/pairs.json`, Kalshi Yes plus the opposite Polymarket outcome (and the reverse) pays 1 when both settle the same way. Pairs are added by hand only after reading both sets of settlement rules.

Each basket is sized to the smallest top-of-book size among its legs, capped at `maxContracts`. Its cost includes the Kalshi taker fee, ceil(0.07 × C × P × (1 − P)) per order, and the Polymarket taker fee where enabled. A basket counts as a hit when its profit is at least `minProfit` dollars (`config/scan.json`). Annualized return divides the return by the time until the last leg closes.

## Run

Requires Node.js 22.4 or newer, with no dependencies.

```sh
node --test
node src/cli.js scan
node scripts/kalshi-scan.js
node src/cli.js serve
```

`scan` prints the current hits. `kalshi-scan.js` also updates the tracked hits in `research/kalshi/`.

## Scheduled scan on GitHub Actions

`.github/workflows/kalshi-scan.yml` runs the tests and a scan every 15 minutes, with no data stored on the local machine. Results live in `research/kalshi/`:

- `latest.md`: open hits and the closest misses from the latest committed scan.
- `state.json`: hits currently open, with first and last sighting.
- `log.jsonl`: hits that disappeared, one per line. `minDurationMs` is a lower bound on each hit's lifetime, measured between scans.

A 15-minute scan commits only when the tracked hits change. A run every 6 hours, and any manual run, also refreshes `latest.md`. GitHub may delay scheduled runs and pauses them after 60 days without repository activity.

## Open the dashboard

Double-click `scripts/open-dashboard.cmd`, or run `powershell -ExecutionPolicy Bypass -File scripts\open-dashboard.ps1`. It starts the local server when needed and opens http://127.0.0.1:8787 in its own window. The dashboard runs a live scan (cached for five minutes) and lists the hits, the hits tracked by the scheduled scan, and the closest misses.

## Limits

- Depth is top of book only. Larger sizes walk the book and cost more.
- A hit seen between two scans may already be gone. Duration is measured at 15-minute resolution.
- The fee rate is one figure for every series. Some series use a different multiplier, so every hit needs its fee schedule and settlement rules checked by hand.
- Money is locked until settlement, which the annualized figure accounts for only roughly.

## Earlier NBA research

The earlier NBA win-probability model, Polymarket archive replay, latency study and market-making simulation are kept at the git tag `nba-archive`. In short: the market midpoint beat the model (Brier 0.145 against 0.165), the market reacted to scoring plays a median 2.2 seconds after ESPN's timestamp, and passive market making lost money under the pessimistic fill rule (−$637 over 74 games).
