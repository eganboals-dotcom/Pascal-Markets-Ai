# Archive replay results

74 of 74 NBA games replayed against archived Polymarket order books (2026-10-27T00:00:00.000Z to 2026-11-06T22:00:00.000Z).
Source: Pendulum Flow Polymarket Orderbook Archive v3.1 (CC BY-NC 4.0), https://archive.pendulumflow.com/.

## Forecast accuracy against the market

Game-weighted Brier score at each score state, lower is better. The market column is the bid-ask midpoint at the same moments.

| Model | Games | Model Brier | Market Brier |
|---|---|---|---|
| candidate | 74 | 0.1650 | 0.1452 |
| baseline | 74 | 0.1664 | 0.1452 |

## Paper trading after fees

$10 per order, one attempt per game, minimum edge 0.04, 3s matching delay.

| Score delay | Model | Trades | Winning | Net P&L | 95% interval |
|---|---|---|---|---|---|
| 5s | candidate | 51 | 22 | -$146.56 | -$265.06 to -$27.06 |
| 5s | baseline | 47 | 22 | -$65.08 | -$193.82 to $63.49 |
| 15s | candidate | 46 | 23 | -$83.70 | -$192.70 to $30.88 |
| 15s | baseline | 42 | 22 | -$19.73 | -$143.62 to $102.63 |
| 30s | candidate | 45 | 25 | -$53.99 | -$162.52 to $55.03 |
| 30s | baseline | 40 | 23 | $30.04 | -$89.61 to $149.48 |

## Assumptions

- Each game replayed on its own with the configured cash; the combined exposure cap across games is not applied
- One order attempt per game, home outcome only, as the replay engine allows
- Score states are the first ESPN play in each regulation minute, timed by play wall clock plus the stated lag
- Book snapshots keep 30 levels per side; level changes over 5 cents from the best price are dropped
- Every fill pays a 5% taker fee schedule; markets were assumed open for orders while the book updated
- Market Brier uses the bid-ask midpoint at each score state, skipping states without a quote in the prior minute
