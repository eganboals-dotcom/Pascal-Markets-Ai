# Market-making simulation

74 games. 10 shares resting at the best bid and ask, inventory capped at 100 shares, held to settlement. No maker fee; the rebate column assumes 15% of the 5% taker fee is returned.

| Fill rule | Fills | Net P&L | Rebates | Markout 10s per share | Markout 60s per share | Games up |
|---|---|---|---|---|---|---|
| pessimistic | 9831 | -$637.05 | $133.79 | -1.03c | -0.93c | 33 of 74 |
| optimistic | 135359 | $185.25 | $1750.11 | 0.00c | 0.04c | 38 of 74 |

Markout is the midpoint after the delay minus the fill price, from the market maker's side; negative values mean fills come from better-informed traders.
Pessimistic fills only when the opposite price crosses the order. Optimistic treats every size decrease at the order's price as trades ahead of it. The true result lies between them.
