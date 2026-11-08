# Strategy review - November 7, 2026 (America/Los_Angeles)

## Conclusion

Profitability is not demonstrated. The recorded 120-event sample produced no qualifying hit before or after the strategy changes. A one-time refresh at 2026-11-08T05:26:47.214Z of 20 selected events (357 markets) also produced no qualifying hit or funded basket, with no request errors. That refresh selected the strongest recorded verified taker events; it is not a market-wide or unbiased sample. No orders were placed.

The best verified taker basket in that refresh was still negative after fees and the one-cent-per-leg reserve: -$0.3555 for nine baskets (-1.94% on reserved cost). These are quoted hypothetical basket economics, not realized returns. Loosening minimum margins would not turn a negative-cost comparison into a viable trade.

## Changes

- Exclusive-event baskets now consider the cheapest fee-adjusted prefixes within the existing bounded depth search. Retained alternatives include the best verified return and the largest qualifying profit under the per-event budget. Expensive legs can otherwise dilute return enough to hide a smaller qualifying basket. The full subset remains available. Final allocation still rechecks both margins after sizing and funds only one basket per event.
- Candidate leg order is canonical, so reordering prices does not create a new identity for an unchanged set of legs.
- An illiquid below-par ladder no longer suppresses a verified near-miss group from discovery in the same event.

No profit threshold, fee assumption, slippage reserve, verification rule, event capital cap, lockup limit, or real-order setting was relaxed.

The independent audit found and reproduced three more defects. Each regression failed before the fix:

- Two funded baskets could each claim the same 100-share Polymarket book, reporting 200 shares. The replay now reserves shared depth in allocation order after concurrent reads. Insufficient fill-or-kill depth is not consumed; already-supported legs can still leave a legged basket.
- Two fresh crossings with only 0.01 contract of opposing depth produced two whole simulated fills and a fictitious $0.03 realized gain. The whole-contract simulator now rejects those fills.
- Proportionally resizing a legacy rounded total could fund four contracts at $2.79084 against a $2.7909 budget even though recalculated costs were $2.79100. Allocation now requires exact leg cost and fee metadata, rejecting old records that lack it.

## Checks

A deterministic synthetic example with two 46-cent No asks and four 99-cent No asks demonstrates the selection defect. With zero series fees, 100-contract depth, a one-cent-per-leg reserve, and a $100 event cap, the full basket fails the 3% return floor. The two-leg subset costs $94 and has a $100 lower-bound payout, a hypothetical $6 margin. The test checks the lower bound against every possible winner, including each excluded outcome and no winner. This fixture illustrates correctness, not available market profit.

A separate fee-bearing fixture checks funded size, depth, and the unchanged $1/3% minimums. Stable IDs, duplicate suppression, bounded output size, and the hidden-ladder regression are tested.

On the saved 120-event, 95-series public sample, no previously watched event's best verified taker return deteriorated. Discovery now covers 89 eligible events versus 86 before this review. These are candidate eligibility improvements, not filled trades.

Local pricing timing excludes network arrival, queue position, execution, and disk logging. The representative sample used 2,400 warm per-event measurements: p95 0.461 ms and maximum 1.198 ms. A separate 120-liquid-outcome synthetic stress case used 100 measurements: p95 7.56 ms, maximum 9.87 ms, below the 100 ms local budget on this machine. Timing does not establish exchange-to-fill latency.

The full regression suite passes all 115 tests.

## Remaining limits

Subset selection is bounded and does not enumerate every subset or walk deeper book levels. Read snapshots do not prove simultaneous execution. Maker variants remain conditional on a fill, and sparse historical records do not establish maker returns or queue behavior. Realized profitability still requires dense observations, conservative execution modeling, and out-of-sample evidence after all costs.

## Venue references

- [Kalshi orderbook responses](https://docs.kalshi.com/getting_started/orderbook_responses): complementary bid/ask sides and fixed-point depth.
- [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding): per-order fee accumulation and direct-member balance precision.
- [Kalshi fixed-point representation](https://docs.kalshi.com/getting_started/fixed_point_migration): market price grids and fractional quantities. The research planner continues to use whole-contract quantities.
