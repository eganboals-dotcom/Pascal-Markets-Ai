# Pascal Markets

A research scanner for mispricing and arbitrage on Kalshi. It reads Kalshi's public REST API, prices every basket that pays out in all outcomes, and records how long each profitable one lasts. It places no orders and needs no account or API key.

## What it looks for

- **No baskets on exclusive events.** At most one outcome of a mutually exclusive event wins, so buying No on all n outcomes pays at least n − 1. Buying Yes on every outcome is not treated as an arbitrage: Kalshi's outcomes need not be exhaustive.
- **Strike-ladder contradictions.** For "above X" markets on the same underlying, Yes at a lower strike plus No at a higher strike always pays 1. "Below X" ladders mirror this. Rungs count as the same underlying only when their settlement rules read the same once the numbers are removed, and rungs must close at the same time, and only one-sided strikes qualify (Kalshi tags some "exactly N" buckets as "less").
- **Cross-venue gaps with Polymarket.** For each reviewed pair in `config/pairs.json`, Kalshi Yes plus the opposite Polymarket outcome (and the reverse) pays 1 when both settle the same way. Pairs are added by hand only after reading both sets of settlement rules.

Each basket is sized to the smallest top-of-book size among its legs, capped at `maxContracts`. Its cost includes the Kalshi taker fee, 0.07 × C × P × (1 − P) per order rounded up to $0.0001 ([fee rounding](https://docs.kalshi.com/getting_started/fee_rounding); a demo fill of 1 contract at $0.33 was charged $0.0155), and the Polymarket taker fee where enabled. Each leg is costed one tick worse (configurable `slippageTicks`) while displaying its seen price. A hit needs at least $1 profit and 3% return by default (`minProfit` and `minReturn`). Series fee multipliers are fetched once per scan. Annualized return divides the return by the time until the last expected expiration.

## Run

Requires Node.js 22.4 or newer, with no dependencies.

```sh
node --test
node src/cli.js scan
node scripts/kalshi-scan.js
node src/cli.js serve
```

`scan` prints the current hits. `kalshi-scan.js` also updates the tracked hits in `research/kalshi/`.

## Dashboard-controlled scanning

Double-click `scripts/open-dashboard.cmd`. The dashboard opens idle. **Start** launches one market-data loop; repeated clicks cannot launch a second loop. **Stop** ends its feed, scans and dry-run subprocesses. Closing the dashboard window stops the loop after at most 20 seconds without status heartbeats. Opening the dashboard again requires Start again. Stopping preserves the last displayed results.

Start selects the production WebSocket feed when `KALSHI_KEY_ID` and `KALSHI_KEY_PATH` are configured; otherwise the 15-second REST watch list is used. Full discovery runs every five minutes. The first discovery can take several minutes. Results and rounds from dashboard sessions are saved under `data/dashboard/`.

The GitHub workflow has no scheduled trigger. A manual archival scan remains available under Actions → Kalshi scan → Run workflow. Explicit command-line scans remain available for research.

## Dry run

New hits in the active loop are checked against public prices after `dryRunDelayMs`. The outcomes filled, missed and legged describe observed price and size availability; they do not establish a real execution. Local records stay in `data/dashboard/dryrun.jsonl`.

## Limits

- Depth is top of book only. Larger sizes walk the book and cost more.
- A hit seen between two scans may already be gone. Duration is measured at 15-minute resolution.
- Money is locked until settlement, which the annualized figure accounts for only roughly.

## Results and market-making research

`node scripts/kalshi-report.js [dir]` summarizes hit episodes, lifetime bounds, dry-run outcomes and the latest near-miss buckets. `node scripts/kalshi-mm-sim.js [dir]` simulates one-contract quotes from the last seven days of `books.jsonl`. The default directory is `research/kalshi`. Both scripts write Markdown and JSON reports; six-hourly and manual workflow runs publish these artifacts and book snapshots.

Quoting candidates require a certified series with settlement sources, focus membership, at least 500 daily contracts, positive depth, a 2–6 cent spread and more than two hours until close or expected expiration. At most `mm.maxMarkets` (50) are recorded per scan, ordered by volume. Quotes sit one cent inside the spread, skew by minus inventory times `mm.skewTicks`, stop at `mm.maxInventory` and pull `mm.pullMinutes` before close. Later opposing-price crossings simulate fills; maker fees follow series settings. Net P&L marks remaining inventory to the last observed mid. The 15-minute markout is a separate adverse-selection diagnostic. Missing future observations are counted explicitly. Candidate filtering and sparse snapshots limit this research model; no queue, settlement, liquidation or incentives are simulated.

## Game-day loop

`node scripts/kalshi-gameday.js [--until=23:59] [--series=KXNBAGAME,...] [--out=data/gameday]` runs until the given local time. A full focus scan, including Polymarket auto-matching, starts every five minutes. Between full scans, up to 20 events are refreshed every 15 seconds using at most eight concurrent event reads. `gameday.fullMinutes`, `gameday.fastSeconds` and `gameday.watchSize` in `config/scan.json` control these settings; `--series` narrows full scans. In REST mode rounds never overlap, and an overlong round makes the next due round start immediately.

The watch list ranks each event's best eligible candidate by profit per basket contract, breaking ties by total event 24-hour volume. Candidates must pass liquidity, closing-time and certification checks. Fast rounds reuse the full scan's series map and matched cross-venue pairs, refreshing public metadata and books without new Polymarket searches. Only successfully refreshed events can close tracked hits in a fast round; full rounds can close any hit. Watched hit durations have roughly 15-second resolution when rounds finish on time.

The output directory holds open hits in `state.json`, closed episodes in `log.jsonl`, dry-run results in `dryrun.jsonl`, and one `rounds.jsonl` line per round with tier, timestamp, duration, event/candidate/hit counts, best profit per contract, errors and full-round watch-list tickers. New hits trigger the shared-budget dry run in a background child using a fixed hit snapshot. If a replay is already running, the round records `dryrunSkipped: true`. The loop reads public data only and places no orders. Use `--out=work/codex-gameday` for isolated test runs.

## Live feed

`node scripts/kalshi-gameday.js --feed --out=work/codex-ws` uses production market data with `KALSHI_KEY_ID` and `KALSHI_KEY_PATH`. Kalshi requires authentication even for market-data WebSockets; a production API key must come from the user's own Kalshi account. Like the demo key, the production private key is stored outside the repository (for example `%USERPROFILE%.kalshiprod-key.pem`), so it cannot be committed; `KALSHI_KEY_PATH` is the feed's sole external file input. The feed only reads market data and never imports order functions.

`--feed=demo --out=work/codex-ws` uses `KALSHI_DEMO_KEY_ID` and `KALSHI_DEMO_KEY_PATH`, demo REST metadata and demo books. The explicitly authorized demo key path may be outside the repository. Demo prices serve plumbing tests only; demo mode skips cross-venue matching. Without `--feed`, or when the selected environment's credentials are missing, the CLI prints the reason and uses the REST fast tier.

Feed mode watches up to `gameday.feedWatchSize` events (default 300), ranked by the full scan. Top-of-book price or size changes reprice only their event, coalesced once per event-loop tick. Full scans run in a worker thread so basket enumeration does not block feed messages, and swap market subscriptions on completion. Feed-owned hits remain under scoped feed tracking; production cross-venue pairs retain Polymarket polling at `gameday.fastSeconds`. Every market in an event must have a fresh snapshot before event pricing resumes after a reconnect or subscription-wide sequence gap. Reconnect delay doubles from one second to a 30-second cap.

Each minute, a `latency` round records receipt-to-result p50, p95 and max in milliseconds, sample count, cumulative feed message counts and watch size. If p95 exceeds `gameday.maxLatencyMs` (default 100 ms), capacity shrinks 20%, dropping the lowest-ranked events, with a minimum capacity of one so latency can still be measured. Capacity grows 10% per full scan, up to the configured maximum, while the latest measured p95 is below half the target; an empty measurement window does not cause growth. Final partial-minute statistics are logged at shutdown. No numeric market subscription limit was found in Kalshi's documentation; the feed uses one connection and one order-book subscription, and reports server subscription errors. Metadata and pair membership refresh on full scans. The feed imports no order client and sends only subscription commands.

## Demo exchange (fake money)

The [Kalshi demo site](https://demo.kalshi.co/) provides separate accounts and mock funds. In the demo account settings, API Keys → Create New API Key creates a demo key; select **RSA**, since this client implements RSA-PSS. Store the private-key file outside the repository with restricted local permissions. Set `KALSHI_DEMO_KEY_ID` and `KALSHI_DEMO_KEY_PATH` locally; neither value belongs in source, logs or workflow secrets for this scanner. The key path is the demo client's sole external file input.

Setup on one machine:

1. Create an account on the Kalshi demo site, then a demo API key (RSA). Kalshi shows the private key once; save it as `%USERPROFILE%\.kalshi\demo-key.pem`, outside the repository.
2. Set the two variables for the current Windows user:
   ```powershell
   [Environment]::SetEnvironmentVariable('KALSHI_DEMO_KEY_ID', '<key id>', 'User')
   [Environment]::SetEnvironmentVariable('KALSHI_DEMO_KEY_PATH', "$env:USERPROFILE\.kalshi\demo-key.pem", 'User')
   ```
   A new terminal picks them up.
3. `node scripts/kalshi-demo-check.js` makes signed read-only calls and prints the fake-money balance. Balance and position reads need only the key; orders and cancels also need the switch.
4. To allow demo orders on this machine only, create `config/trading.local.json` (gitignored) containing `{ "enabled": true, "venue": "demo" }`. It overrides `trading` in `config/scan.json`, which stays disabled.

Demo markets and prices differ from production, so production hits rarely exist on demo; the demo run mainly exercises signing, order placement and partial-fill handling.

`node scripts/kalshi-demo.js [dir]` prints a budgeted plan from currently open, verified and reviewed Kalshi hits with a current filled dry run. It sends nothing by default. Sending fake-money IOC limit orders additionally requires `--send` and the local switch in `config/trading.local.json`. The shipped configuration stays disabled. Series must also appear in `verified.reviewedSeries`. Stable client order IDs identify repeated plans; sequential legs can still partially fill, and execution stops on a partial fill or error. The budget applies to one batch; repeated experiments require manual position reconciliation.

Only `https://demo-api.kalshi.co/trade-api/v2` is accepted; production hosts and redirects are rejected. Kalshi's [demo endpoint documentation](https://docs.kalshi.com/getting_started/demo_env) lists this host as supported. Requests use the [documented authentication headers and RSA-PSS signing](https://docs.kalshi.com/getting_started/api_keys) and the [V2 order endpoint](https://docs.kalshi.com/api-reference/orders/create-order-v2). Demo markets may differ from public production markets. No workflow imports or runs this client. Live trading is out of scope and requires a separately reviewed implementation and explicit funds approval.

## Verification and review

Verified candidates require a Kalshi product-certification URL, event settlement sources, at least 500 contracts of 24-hour volume on every Kalshi leg, matching close times, and more than two hours until the first close or expected expiration of any leg (a game already in play keeps a far close time, so its expected expiration is what flags it). The Verified column lists failed checks. `verified.reviewedSeries` records manual series review separately. Hits require verification; unverified candidates remain visible among misses. The dry run uses verification; any future live trading must require `verified && reviewed`, as well as separately approved execution and risk controls. Certification identifies a Kalshi-issued contract; it does not guarantee profit.

## Maker baskets

Maker variants rest the widest-spread leg at its bid plus one tick and take the other legs only after a fill. The resting leg needs a non-zero bid and a spread of at most `makerMaxSpread` (default 4¢): on an empty or wide book such a bid fills only after the price has moved against it. Plain quadratic series have no maker fee; other series use `makerFeeRate` times their multiplier. The real maker fee and liquidity-incentive rebates must be checked against [Kalshi fee schedule](https://kalshi.com/fee-schedule). Rebates are never counted as profit. These candidates are labelled **maker (needs a fill)**: a seller must hit the resting order, often just before an adverse price move. The basket dry run skips them.

## Focus and lockup

The live public `/series` response (2026-11-07 UTC, 15,900 series) confirmed prefixes `KXNBA`, `KXNFL`, `KXMLB`, `KXNHL`, `KXEPL`, `KXMLS`, `KXLALIGA`, `KXLIGUE1`, `KXUCL`, `KXSERIEA`, `KXBUNDESLIGA`, `KXUFC`, and `KXBOX`. Game-winner series include `KXNBAGAME`, `KXNFLGAME`, `KXMLBGAME`, `KXNHLGAME`, `KXEPLGAME`, `KXMLSGAME`, `KXUCLGAME`, `KXUFCFIGHT`, and `KXBOXING`. Confirmed tags are Basketball, Football, Baseball, Hockey, Soccer, MMA, Boxing, Tennis, and Golf; these include team and player awards. Economics, World, and Financials are also included. Focus uses any matching prefix, tag, or category.

Lockup and annualized return use expected expiration, falling back to close time. Every candidate is capped at 60 days unless it yields at least $0.03 per basket contract and 10% annualized within 400 days; exceptions carry `longHold: true`. Close times still govern the close-time verification checks.

Automatic sports lookups skip games with no Kalshi leg meeting the volume requirement. Matches compare both team names (including league-scoped Polymarket team aliases) and UTC game date within one day. Only moneylines with compatible overtime or regulation rules qualify; unknown wording and ambiguous matches are skipped. [Kalshi basketball terms](https://assets.kalshi.com/contract_terms/BASKETBALLGAMEWIN.pdf) and [football terms](https://assets.kalshi.com/contract_terms/FOOTBALLGAMEWIN.pdf) include overtime by default for full games. Soccer requires regulation wording; fights require explicit matching draw/no-contest half payouts. Automatic pairs remain `autoMatched: true, reviewed: false`, never enter `config/pairs.json`, and need manual confirmation before live use. Both venues must also settle a cancelled or postponed game the same fixed way (Yes, No or 50-50); a Kalshi "fair price" or unstated terms reject the pair. On 2026-11-07 two EFL League One draw pairs priced at a 16% return failed exactly here: Polymarket resolves the draw market Yes if the game does not start, Kalshi pays a fair price, and Polymarket traders priced the draw at 97% a week out, consistent with an expected postponement. Auto matches remain research candidates; the cancellation check reads wording and is no substitute for manual review. Public Gamma lookups and books share a per-scan cache and a five-request-per-second limit; errors are recorded while Kalshi scanning continues.

The basket dry run checks only hits that are new in the latest scan, so a persisting hit is replayed once. It funds verified taker hits best-annualized first, with a shared $1,000 bankroll, $100 per event, one basket per event, and at most 20 events (`budget`). Resized order fees are recomputed. All funded hits share one delay deadline; up to eight Kalshi reads run concurrently with HTTP 429 backoff. Cross-venue research plans also recheck Polymarket acceptance and public books. Skipped hits record their reason in `dryrun.jsonl`. Limits describe one simultaneous replay batch; no persistent live positions or funds are managed.
