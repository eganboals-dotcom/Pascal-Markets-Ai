# Buying favorites, by category and by event, on the Becker dataset (Kalshi trades, July 2021 to Nov 2025). The flow test showed
# takers who bought politics markets at 80c or more winning in both halves; this checks it the way a bot would trade it. Rule: on
# each day a market has a taker buying a side at 80 to 97c, buy one contract of that side at the day's FIRST such price (the last would peek at the rest of the day), pay the
# 7% taker fee, hold to settlement. Results are grouped by event, with a 95% range from resampling whole events. Read-only.
import glob, random, sys
import duckdb

root = 'data/becker'  # run from the project root
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")
db.execute("SET memory_limit = '10GB'")
db.execute(f"SET temp_directory = '{sys.argv[1]}'")
rows = db.execute(f"""
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time::TIMESTAMPTZ AS close_time
    FROM read_parquet({MARKETS!r})
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume >= 1000 AND ticker NOT LIKE 'KXMVE%'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT t.ticker, m.event_ticker, t.taker_side, t.created_time::TIMESTAMPTZ AS ts, m.close_time,
      (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) / 100.0 AS p, (m.result = t.taker_side)::INT AS win
    FROM read_parquet({TRADES!r}) t JOIN m ON m.ticker = t.ticker
    WHERE t.taker_side IN ('yes', 'no') AND t.created_time::TIMESTAMPTZ < m.close_time
      AND (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) BETWEEN 80 AND 97),
  d AS (
    SELECT ticker, event_ticker, taker_side, date_trunc('day', ts) AS day, arg_min(p, ts) AS p, any_value(win) AS win,
      epoch(any_value(close_time) - min(ts)) / 86400.0 AS days
    FROM t GROUP BY ALL)
  SELECT event_ticker, regexp_extract(ticker, '^([A-Z0-9]+)', 1) AS series,
    CASE WHEN regexp_matches(ticker, '^(KX)?(BTC|ETH|SOL|XRP|DOGE)') THEN 'crypto'
         WHEN regexp_matches(ticker, '^(KX)?(INX|NASDAQ|SP500|WTI|GOLD|USDJPY|EURUSD|TNOTE)') THEN 'markets'
         WHEN regexp_matches(ticker, '^(KX)?(HIGH|LOW|RAIN|SNOW|TEMP|HURR|TORNADO)') THEN 'weather'
         WHEN regexp_matches(ticker, '^(KX)?(PRES|POPVOTE|ECMOV|SENATE|HOUSE|GOV|MAYOR|FED|CPI|GDP|PAYROLLS|UNEMP|RATECUT|SHUTDOWN|TRUMP|CABINET|SCOTUS|APPROVE|ELECTION|EC[A-Z])') THEN 'politics-econ'
         WHEN regexp_matches(ticker, '^(KX)?(NFL|NBA|MLB|NHL|NCAA|WNBA|MARMAD|WMARMAD|UFC|ATP|WTA|PGA|MASTERS|USOPEN|THEOPEN|WMENSINGLES|EPL|UCL|LALIGA|BUNDESLIGA|SERIEA|LIGUE|MLS|F1|NASCAR|FIFA|SOCCER|TENNIS|GOLF|BOX|WIMBLEDON|FRENCHOPEN|AUSOPEN|CS2|LOL|VALORANT|DOTA|CRICKET|IPL)') THEN 'sports'
         ELSE 'other' END AS cat,
    year(day)::INT AS yr, CASE WHEN p < 0.9 THEN '80-89c' WHEN p < 0.95 THEN '90-94c' ELSE '95-97c' END AS band,
    CASE WHEN days < 1 THEN 'under 1 day' WHEN days < 7 THEN '1-7 days' ELSE 'over 7 days' END AS held,
    count(*) AS n, sum(win - p - 0.07 * p * (1 - p)) AS pnl, sum(p) AS stake, sum(days) AS days
  FROM d GROUP BY ALL""").fetchall()
COLS = ['event', 'series', 'cat', 'yr', 'band', 'held', 'n', 'pnl', 'stake', 'days']
R = [dict(zip(COLS, r)) for r in rows]
print('buys', sum(r['n'] for r in R), 'events', len({r['event'] for r in R}))
random.seed(5)

def show(name, rs, pad=34):
    by = {}
    for r in rs:
        e = by.setdefault(r['event'], [0, 0.0, 0.0, 0.0]); e[0] += r['n']; e[1] += r['pnl']; e[2] += r['stake']; e[3] += r['days']
    ev = list(by.values()); n = sum(e[0] for e in ev)
    if n < 300 or len(ev) < 30: return
    means = []
    for _ in range(600):
        s = random.choices(ev, k=len(ev)); means.append(100 * sum(e[1] for e in s) / sum(e[0] for e in s))
    means.sort(); pnl = sum(e[1] for e in ev); days = sum(e[3] for e in ev) / n
    print(f'  {name.ljust(pad)} buys {n:>8} events {len(ev):>6} | {100 * pnl / n:6.2f}c a contract ({means[15]:6.2f} to {means[584]:6.2f}) | held {days:6.1f} days on average | {100 * pnl / sum(e[2] for e in ev):6.2f}% of the stake')

print('\nBy category:')
for c in sorted({r['cat'] for r in R}): show(c, [r for r in R if r['cat'] == c])
print('\nBy category and year:')
for c in sorted({r['cat'] for r in R}):
    for y in sorted({r['yr'] for r in R}): show(f'{c} {y}', [r for r in R if r['cat'] == c and r['yr'] == y])
print('\nBy category and price:')
for c in sorted({r['cat'] for r in R}):
    for b in ['80-89c', '90-94c', '95-97c']: show(f'{c} {b}', [r for r in R if r['cat'] == c and r['band'] == b])
print('\nBy category and time to close:')
for c in sorted({r['cat'] for r in R}):
    for h in ['under 1 day', '1-7 days', 'over 7 days']: show(f'{c}, {h}', [r for r in R if r['cat'] == c and r['held'] == h])
print('\nPolitics and economics, the 15 series with the most buys:')
P = [r for r in R if r['cat'] == 'politics-econ']; count = {}
for r in P: count[r['series']] = count.get(r['series'], 0) + r['n']
for s in sorted(count, key=count.get, reverse=True)[:15]:
    rs = [r for r in P if r['series'] == s]; n = sum(r['n'] for r in rs)
    print(f'  {s.ljust(26)} buys {n:>7} events {len({r["event"] for r in rs}):>5} | {100 * sum(r["pnl"] for r in rs) / n:6.2f}c a contract')
