# Pascal Markets

NBA prediction-market research, probability training, sportsbook comparison, and delayed paper execution.

## Run

Requires Node.js 22.4 or newer. This initial implementation uses built-in Node modules.

```sh
node --test
node src/cli.js demo
node src/cli.js serve
node src/cli.js discover
node src/cli.js record data/nba-sports.jsonl 60
node src/cli.js train data/training.jsonl 2026-10-01T00:00:00Z models/nba.json
node src/cli.js replay data/holdout.jsonl config/paper.json
```

The dashboard runs at http://127.0.0.1:8787. Run `node src/cli.js help` for the complete command list.

## Capture and inspect public markets

```sh
node src/cli.js discover data/catalog.json
node src/cli.js capture data/capture-session 60
node src/cli.js analyze data/capture-session
```

Choose a new capture directory for each session. Capture records sports updates and both outcome books for up to six nearby NBA games. Analysis reconstructs quotes from snapshots and deltas, checks book consistency and writes `quotes.jsonl` and `analysis.json`. Gap markers invalidate previous quotes. Capture records connection boundaries and retries up to five disconnects.

Market metadata is captured at the start of a session. Replay rejects metadata older than its configured limit, which defaults to 60 seconds. Longer trading experiments require refreshed market metadata. A successful connection can receive zero sports updates during a quiet period.

## Sportsbook comparison

The optional snapshot adapter reads `ODDS_API_KEY` from the environment. Copy `.env.example` to `.env` and set your own provider key locally, then run the following command. This request consumes provider quota.

```sh
node --env-file=.env src/cli.js odds data/sportsbook.json
node src/cli.js compare data/catalog.json data/capture-session/quotes.jsonl data/sportsbook.json config/mappings.json
```

Prepare `config/mappings.json` from `config/mappings.example.json` after checking both teams, start time, bookmaker, full-game rules and the catalog rules hash. The comparator requires a reviewed mapping and checks data freshness, fees and suspension status. The Odds API does not guarantee an explicit suspension flag, so these snapshots remain research inputs when that status is unavailable. Its published in-play moneyline interval is 40 seconds. A faster feed must demonstrate its advantage through measured timestamps. [Provider update intervals](https://the-odds-api.com/sports-odds-data/update-intervals.html)

## Build real datasets

```sh
node src/cli.js build-training data/states.jsonl data/pregame.jsonl data/settlements.jsonl data/training.jsonl
node src/cli.js build-replay data/quotes.jsonl data/normalized-sportsbook.jsonl data/settlements.jsonl data/replay.jsonl
```

Training states require `gameId`, `sourceAt`, `receivedAt`, `period` (1–4), `clockSeconds` remaining in the quarter, `homeScore`, `awayScore` and `status` equal to `InProgress`. Pregame estimates require `gameId`, `probability`, `recordedAt` and `startsAt`, with recording before tipoff. Settlement records require `gameId`, `resolvedAt`, `homeWon`, `source` and `verified` equal to `true`. Use `homeWon` equal to `null` with a `settlementPayout` between zero and one for canceled contracts. Such records are excluded from binary model training.

Replay joins data using local receipt timestamps. Normalized sportsbook records use the schema below. Real historical state data and final outcomes must be supplied from an appropriate provider.

The demo generates artificial NBA observations, trains the baseline, evaluates four later games and runs both signal policies. Its files and report are in `data/demo/`. Synthetic results demonstrate software behavior only. Run the demo before using real data to verify the local pipeline.

All CLI file paths resolve relative to this project folder. Paths outside the folder, including links to external directories, are rejected. Generated datasets, models and reports stay here. The test suite also creates its fixtures inside `data/demo/`.

For model-driven replay, set `signal` to `model` in a copy of the configuration and supply the model as the last replay argument.

## Current implementation

- Public NBA event discovery with cursor pagination.
- Bounded live NBA sports and book recording, heartbeat replies, reconnection boundaries, raw payloads and local receipt timestamps.
- Regularized logistic home-win baseline trained from score difference, regulation time remaining, and pregame probability. Each game receives equal training weight.
- Chronological holdout evaluation with game-weighted Brier score, log loss, and pregame baseline. Games must resolve before the training cutoff to enter training.
- Two-way sportsbook margin removal with timestamp, suspension, and settlement checks.
- Home-outcome paper replay using a later quote after the configured or venue matching delay, whichever is greater. Reserves exposure and cash for pending proposals, limits fills to available top-of-book quantity, and enforces limit prices and per-share fee assumptions. Proposals expire when the execution window passes.

The first version supports regulation-time observations for full-game NBA moneyline contracts including overtime. One proposal per game keeps the baseline experiment bounded. Outcomes are used for evaluation and settlement only. Simulation amounts are illustrative research settings.

## Data contract

Training and replay consume JSON Lines, one normalized observation per line. All timestamps are UTC epoch milliseconds. `resolvedAt` is when the final outcome became known. `observedAt` must represent when the complete feature set was available locally. Pregame probability must have been fixed before tipoff.

```json
{"gameId":"nba-example","observedAt":1790000000000,"resolvedAt":1790001000000,"homeScore":80,"awayScore":75,"secondsRemaining":600,"pregameHomeProbability":0.55,"homeWon":1,"quote":{"gameId":"nba-example","assetId":"verified-home-outcome-id","sourceAt":1790000000000,"receivedAt":1790000000000,"ask":0.6,"askSize":50,"outcome":"home","marketType":"moneyline","includesOvertime":true,"acceptingOrders":true,"secondsDelay":3},"sportsbook":{"gameId":"nba-example","sourceAt":1790000000000,"receivedAt":1790000000000,"homeOdds":1.5,"awayOdds":2.8,"format":"decimal","marketType":"moneyline","includesOvertime":true,"suspended":false}}
```

Match game, teams, outcome asset, full-game scope and overtime rules explicitly when preparing data. Reject ambiguous mappings. The raw Polymarket sports recorder is an input archive, and requires normalization plus historical outcomes and synchronized quotes before training or replay. Feed `elapsed` values are deliberately preserved raw because clock semantics require provider validation.

## Research limitations

This is a research and paper-trading foundation. Real historical training data, a licensed faster sportsbook feed, automatic metadata refresh and live execution remain future work. The included model demonstration uses synthetic data.

The default fee setting is a user-supplied per-share assumption. Set `feeMode` to `market` to use a quote's `feesEnabled` and supported `feeSchedule` fields. Paper replay assumes top-of-book liquidity at a subsequent observation, and cannot prove a live fill. It models a bounded immediate attempt, holds fills to settlement and assumes no competing queue consumption. The current model's features are a baseline and need possession, lineups, fouls, timeouts and overtime treatment before broader evaluation.

Polymarket warns that its sports stream may be delayed or contain errors. A faster sportsbook is a hypothesis to measure using source and receipt timestamps, comparable contracts, and executable prices after delays. Vendor timestamp accuracy and odds-feed licensing must be verified.

## Next milestones

1. Select a licensed NBA odds and play-by-play provider with measured source timestamps.
2. Record synchronized sportsbook quotes and Polymarket order books, with verified game/outcome mappings.
3. Build point-in-time historical datasets with final outcomes and market-specific fee schedules.
4. Evaluate sportsbook and learned signals on separate games, including unfavorable latency and liquidity scenarios.
5. Add persistent order reconciliation, risk enforcement and operational monitoring before an approved live pilot.

## Browser verification

The application has no runtime package dependencies. Playwright is a development dependency for desktop and mobile dashboard checks. Project npm settings and the browser installation script keep caches inside this folder.

```sh
npm ci
node scripts/install-browser.js
node scripts/browser-smoke.js
```

Screenshots are saved under `outputs/`. Recordings, models, credentials, caches and installed packages are excluded from Git.

## References

- https://docs.polymarket.com/market-data/discover-markets
- https://docs.polymarket.com/market-data/realtime-data
- https://docs.polymarket.com/trading/place-orders
- https://docs.polymarket.com/trading/fees
