# Algorithm review

Reviewed 2026-11-07. Scope: basket pricing, ladder identity, market-data freshness, watch-list selection, and budgeted dry-run planning. The research strategies, $1 minimum profit, 3% minimum return, focus markets and lockup policy remain in place. No orders were submitted.

## Findings and changes

| Finding | Resolution |
| --- | --- |
| A long-lived Polymarket lookup reused completed books and trading status indefinitely. Rejected requests also stayed cached. | Book and market calls now deduplicate only overlapping requests; later reads refresh and failures can be retried. Discovery metadata remains cached behind the existing rate gate. |
| Feed gaps and disconnects invalidated books without withdrawing old hits. Failed REST reads and dropped watch-list events could also preserve old signals. | Feed invalidation notifies affected events. Their hits are removed until fresh snapshots permit repricing. Failed REST reads clear their scope. Failed discovery in feed mode preserves only feed-owned signals. |
| Kalshi could move while a cross-venue HTTP read was pending. | The Kalshi leg is read again from the live book immediately before the comparison is priced. Missing live books suppress the comparison. |
| The 99-cent cost cap could lower the observed cost of a subcent quote above 99 cents and omit the buffer on a 99-cent quote. | Buffered cost may reach $1, without lowering the observed price. Invalid depth, empty legs and negative fee multipliers are rejected. |
| Removing every number from ladder rules could merge different dates, periods or numbered players. | Only a recognized strike comparison is masked. Other numbers, secondary rules and both close and expected-expiration times remain part of identity. Half-point integer sports thresholds are handled explicitly; ambiguous text fails closed. |
| An ordinary negative ladder could be absent from discovery until its next full scan. | One closest negative taker ladder per event is retained when no below-par ladder exists. Watch-list candidates must pass all verification checks. |
| Budget reduction checked only that profit stayed positive. | Exact resized fees determine the largest affordable whole-contract size. Minimum profit and return are checked again; rejected sizes do not consume the batch budget. This also applies to demo planning. |
| A one-cent maker improvement from a subcent bid could be off the allowed price grid. | Research maker quotes round upward to a whole-cent price and must remain strictly below the ask. |
| A Polymarket dry-run check considered only one ask level; an empty fill list counted as filled. | The check totals available size at or below the limit, and an empty plan is missed. |

## Validation

- **100 tests passed**, including new regressions for price boundaries, invalid depth, rule mismatches, allocation thresholds, refreshed prices, failed reads, feed gaps and prices changing during cross-venue requests.
- The initial nine focused regression cases failed against the original implementation before fixes were applied.
- Offline comparison used **120 recorded public events from 95 series**, with at most three events per series and at least two active markets meeting the volume and short-horizon selection rules. The source snapshot file was saved at **2026-11-07 07:55 UTC**. This was a deterministic discovery sample, not a representative estimate of all market opportunities.

| Recorded sample | Before | After |
| --- | ---: | ---: |
| Retained candidates | 127 | 170 |
| Candidates passing all verification checks | 33 | 80 |
| Events with at least one such candidate | 23 | 68 |
| Qualifying hits | 0 | 0 |

After one warm-up pass, **2,400 individual event repricings** measured approximately **0.076 ms p50**, **0.322 ms p95** and **0.600 ms maximum** on the local machine. These timings cover basket enumeration and hit filtering only; they exclude network delivery, queueing, disk writes, GUI updates and execution. Full-sample computation increased from about 12.3 ms to 17.9 ms while retaining more candidates.

Repricing **850 recorded dashboard candidate observations** with the corrected cost buffer changed 192 reported margins, all downward. Repeated observations are counted separately. No increase in recorded profit was fabricated.

## Remaining limits

Pass: reproduced defects fixed; offline tests and bounded local computation checks passed. Research warning: neither the replay nor the benchmark establishes profitability, available fills, continuous opportunity duration or exchange-to-result latency. No live-money step was performed or requested.

Kalshi sizing remains top of book; maker fills, queue priority, cross-venue settlement equivalence and liquidation costs still need stronger empirical validation. Ladder text matching intentionally skips unsupported wording. Metadata refreshes on full scans, so intraday lifecycle changes are not yet driven by a dedicated lifecycle subscription. The allocator models one replay batch and does not reserve capital across real positions. The sparse market-making model marks inventory to sampled midpoints; it is not realized trading P&L.

Next measurement: collect timestamped production-feed observations during dashboard sessions and compare candidate survival, available depth and adverse selection before considering a change to margin requirements.

## Primary references checked

- [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding): direct-member balance alignment, order fee accumulator, and fill rounding.
- [Kalshi fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf): quadratic taker and maker formulas and series multipliers.
- [Kalshi orderbook responses](https://docs.kalshi.com/getting_started/orderbook_responses): bids-only books, complementary asks, and fixed-point sizes.
- [Kalshi orderbook updates](https://docs.kalshi.com/websockets/orderbook-updates): snapshot replacement and subscription sequence tracking.
- [Kalshi fixed-point representation](https://docs.kalshi.com/getting_started/fixed_point_migration): subcent prices, market-specific grids and whole-cent prices valid across documented structures.
