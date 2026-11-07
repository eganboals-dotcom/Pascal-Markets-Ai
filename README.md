# Pascal Markets

A research scanner for mispricing and arbitrage on Kalshi. It reads Kalshi's public REST API, prices every basket that pays out in all outcomes, and records how long each profitable one lasts. It places no orders and needs no account or API key.

## What it looks for

- **No baskets on exclusive events.** At most one outcome of a mutually exclusive event wins, so buying No on all n outcomes pays at least n − 1. Buying Yes on every outcome is not treated as an arbitrage: Kalshi's outcomes need not be exhaustive.
- **Strike-ladder contradictions.** For "above X" markets on the same underlying, Yes at a lower strike plus No at a higher strike always pays 1. "Below X" ladders mirror this. Rungs count as the same underlying only when their settlement rules read the same once the numbers are removed, and rungs must close at the same time, and only one-sided strikes qualify (Kalshi tags some "exactly N" buckets as "less").
- **Cross-venue gaps with Polymarket.** For each reviewed pair in `config/pairs.json`, Kalshi Yes plus the opposite Polymarket outcome (and the reverse) pays 1 when both settle the same way. Pairs are added by hand only after reading both sets of settlement rules.

Each basket is sized to the smallest top-of-book size among its legs, capped at `maxContracts`. Its cost includes the Kalshi taker fee, ceil(0.07 × C × P × (1 − P)) per order, and the Polymarket taker fee where enabled. Each leg is costed one tick worse (configurable `slippageTicks`) while displaying its seen price. A hit needs at least $1 profit and 3% return by default (`minProfit` and `minReturn`). Series fee multipliers are fetched once per scan. Annualized return divides the return by the time until the last expected expiration.

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

## Dry run

After each scheduled scan, a dry-run replays open hits against current market data. It plans which orders the bot would send, waits `dryRunDelayMs` (30 s by default), then checks whether every order would still fill at today's top-of-book price and depth. The three outcomes are: **filled** (all legs catchable), **missed** (none catchable), or **legged** (some filled, some not). No real orders are placed; the file `research/kalshi/dryrun.jsonl` records every replay line by line.

## Open the dashboard

Double-click `scripts/open-dashboard.cmd`, or run `powershell -ExecutionPolicy Bypass -File scripts\open-dashboard.ps1`. It starts the local server when needed and opens http://127.0.0.1:8787 in its own window. The dashboard runs a live scan (cached for five minutes) and lists the hits, the hits tracked by the scheduled scan, and the closest misses.

## Limits

- Depth is top of book only. Larger sizes walk the book and cost more.
- A hit seen between two scans may already be gone. Duration is measured at 15-minute resolution.
- Money is locked until settlement, which the annualized figure accounts for only roughly.

## Results and market-making research

`node scripts/kalshi-report.js [dir]` summarizes hit episodes, lifetime bounds, dry-run outcomes and the latest near-miss buckets. `node scripts/kalshi-mm-sim.js [dir]` simulates one-contract quotes from the last seven days of `books.jsonl`. The default directory is `research/kalshi`. Both scripts write Markdown and JSON reports; six-hourly and manual workflow runs publish these artifacts and book snapshots.

Quoting candidates require a certified series with settlement sources, focus membership, at least 500 daily contracts, positive depth, a 2–6 cent spread and more than two hours until close or expected expiration. At most `mm.maxMarkets` (50) are recorded per scan, ordered by volume. Quotes sit one cent inside the spread, skew by minus inventory times `mm.skewTicks`, stop at `mm.maxInventory` and pull `mm.pullMinutes` before close. Later opposing-price crossings simulate fills; maker fees follow series settings. Net P&L marks remaining inventory to the last observed mid. The 15-minute markout is a separate adverse-selection diagnostic. Missing future observations are counted explicitly. Candidate filtering and sparse snapshots limit this research model; no queue, settlement, liquidation or incentives are simulated.

## Demo exchange (fake money)

The [Kalshi demo site](https://demo.kalshi.co/) provides separate accounts and mock funds. In the demo account settings, API Keys → Create New API Key creates a demo key; select **RSA**, since this client implements RSA-PSS. Store the private-key file outside the repository with restricted local permissions. Set `KALSHI_DEMO_KEY_ID` and `KALSHI_DEMO_KEY_PATH` locally; neither value belongs in source, logs or workflow secrets for this scanner. The key path is the demo client's sole external file input.

`node scripts/kalshi-demo.js [dir]` prints a budgeted plan from currently open, verified and reviewed Kalshi hits with a current filled dry run. It sends nothing by default. Sending fake-money IOC limit orders additionally requires `--send` and a deliberate local change to `trading.enabled: true` with `trading.venue: "demo"`. The shipped configuration stays disabled. Series must also appear in `verified.reviewedSeries`. Stable client order IDs identify repeated plans; sequential legs can still partially fill, and execution stops on a partial fill or error. The budget applies to one batch; repeated experiments require manual position reconciliation.

Only `https://demo-api.kalshi.co/trade-api/v2` is accepted; production hosts and redirects are rejected. Kalshi's [demo endpoint documentation](https://docs.kalshi.com/getting_started/demo_env) lists this host as supported. Requests use the [documented authentication headers and RSA-PSS signing](https://docs.kalshi.com/getting_started/api_keys) and the [V2 order endpoint](https://docs.kalshi.com/api-reference/orders/create-order-v2). Demo markets may differ from public production markets. No workflow imports or runs this client. Live trading is out of scope and requires a separately reviewed implementation and explicit funds approval.

## Verification and review

Verified candidates require a Kalshi product-certification URL, event settlement sources, at least 500 contracts of 24-hour volume on every Kalshi leg, matching close times, and more than two hours until the first close or expected expiration of any leg (a game already in play keeps a far close time, so its expected expiration is what flags it). The Verified column lists failed checks. `verified.reviewedSeries` records manual series review separately. Hits require verification; unverified candidates remain visible among misses. The dry run uses verification; any future live trading must require `verified && reviewed`, as well as separately approved execution and risk controls. Certification identifies a Kalshi-issued contract; it does not guarantee profit.

## Maker baskets

Maker variants rest the widest-spread leg at its bid plus one tick and take the other legs only after a fill. The resting leg needs a non-zero bid and a spread of at most `makerMaxSpread` (default 4¢): on an empty or wide book such a bid fills only after the price has moved against it. Plain quadratic series have no maker fee; other series use `makerFeeRate` times their multiplier. The real maker fee and liquidity-incentive rebates must be checked against [Kalshi fee schedule](https://kalshi.com/fee-schedule). Rebates are never counted as profit. These candidates are labelled **maker (needs a fill)**: a seller must hit the resting order, often just before an adverse price move. The basket dry run skips them.

## Focus and lockup

The live public `/series` response (2026-11-07 UTC, 15,900 series) confirmed prefixes `KXNBA`, `KXNFL`, `KXMLB`, `KXNHL`, `KXEPL`, `KXMLS`, `KXLALIGA`, `KXLIGUE1`, `KXUCL`, `KXSERIEA`, `KXBUNDESLIGA`, `KXUFC`, and `KXBOX`. Game-winner series include `KXNBAGAME`, `KXNFLGAME`, `KXMLBGAME`, `KXNHLGAME`, `KXEPLGAME`, `KXMLSGAME`, `KXUCLGAME`, `KXUFCFIGHT`, and `KXBOXING`. Confirmed tags are Basketball, Football, Baseball, Hockey, Soccer, MMA, Boxing, Tennis, and Golf; these include team and player awards. Economics, World, and Financials are also included. Focus uses any matching prefix, tag, or category.

Lockup and annualized return use expected expiration, falling back to close time. Every candidate is capped at 60 days unless it yields at least $0.03 per basket contract and 10% annualized within 400 days; exceptions carry `longHold: true`. Close times still govern the close-time verification checks.

Automatic sports lookups skip games with no Kalshi leg meeting the volume requirement. Matches compare both team names (including league-scoped Polymarket team aliases) and UTC game date within one day. Only moneylines with compatible overtime or regulation rules qualify; unknown wording and ambiguous matches are skipped. [Kalshi basketball terms](https://assets.kalshi.com/contract_terms/BASKETBALLGAMEWIN.pdf) and [football terms](https://assets.kalshi.com/contract_terms/FOOTBALLGAMEWIN.pdf) include overtime by default for full games. Soccer requires regulation wording; fights require explicit matching draw/no-contest half payouts. Automatic pairs remain `autoMatched: true, reviewed: false`, never enter `config/pairs.json`, and need manual confirmation before live use. Cancellation and postponement provisions still need manual comparison: auto matches are research candidates, with no guaranteed cross-venue payout in those cases. Public Gamma lookups and books share a per-scan cache and a five-request-per-second limit; errors are recorded while Kalshi scanning continues.

The basket dry run checks only hits that are new in the latest scan, so a persisting hit is replayed once. It funds verified taker hits best-annualized first, with a shared $1,000 bankroll, $100 per event, one basket per event, and at most 20 events (`budget`). Resized order fees are recomputed. All funded hits share one delay deadline; up to eight Kalshi reads run concurrently with HTTP 429 backoff. Cross-venue research plans also recheck Polymarket acceptance and public books. Skipped hits record their reason in `dryrun.jsonl`. Limits describe one simultaneous replay batch; no persistent live positions or funds are managed.
