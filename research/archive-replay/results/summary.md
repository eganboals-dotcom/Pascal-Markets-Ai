# Archive replay results

74 of 74 NBA games replayed against archived Polymarket order books (2026-10-27T00:00:00.000Z to 2026-11-06T22:00:00.000Z).
Source: Pendulum Flow Polymarket Orderbook Archive v3.1 (CC BY-NC 4.0), https://archive.pendulumflow.com/.

## Forecast accuracy against the market

Game-weighted Brier score at each score state, lower is better. The market column is the bid-ask midpoint at the same moments.

| Model | Games | Model Brier | Market Brier |
|---|---|---|---|
| candidate | 74 | 0.1625 | 0.1426 |
| baseline | 74 | 0.1634 | 0.1426 |

## Paper trading after fees

$10 per order, one attempt per game, minimum edge 0.04, 3s matching delay.

| Score delay | Model | Trades | Winning | Net P&L | 95% interval |
|---|---|---|---|---|---|
| 5s | candidate | 5 | 3 | -$2.13 | -$38.78 to $31.73 |
| 5s | baseline | 5 | 4 | $20.78 | -$13.76 to $60.04 |
| 15s | candidate | 7 | 4 | -$10.21 | -$48.90 to $25.04 |
| 15s | baseline | 4 | 2 | -$9.14 | -$41.90 to $18.41 |
| 30s | candidate | 4 | 4 | $18.27 | $2.54 to $37.99 |
| 30s | baseline | 6 | 2 | -$28.86 | -$71.78 to $5.97 |

## Assumptions

- Each game replayed on its own with the configured cash; the combined exposure cap across games is not applied
- One order attempt per game, home outcome only, as the replay engine allows
- Score states are the first ESPN play in each regulation minute, timed by play wall clock plus the stated lag
- Book snapshots keep 30 levels per side; level changes over 5 cents from the best price are dropped
- Every fill pays a 5% taker fee schedule; markets were assumed open for orders while the book updated
- Market Brier uses the bid-ask midpoint at each score state, skipping states without a quote in the prior minute
