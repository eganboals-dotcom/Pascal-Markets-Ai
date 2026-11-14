# "Will they say this word" markets on the Becker dataset (Kalshi trades to Nov 2025): which side is mispriced? Rule, with no
# look-ahead: on each day, in each market, copy the day's FIRST taker on each side, one contract at the price that taker paid,
# 7% taker fee, held to settlement. Results by side, price paid and hours to the market's close, grouped by event (one speech,
# show or call), with a 95% range from resampling whole events, and each half of the events shown apart. Read-only.
import glob, random, sys
import duckdb

root = 'data/becker'  # run from the project root
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")
db.execute("SET memory_limit = '10GB'")
db.execute(f"SET temp_directory = '{sys.argv[1]}'")
db.execute("SET enable_progress_bar = false")
rows = db.execute(f"""
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time::TIMESTAMPTZ AS close_time
    FROM read_parquet({MARKETS!r})
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND regexp_matches(ticker, 'MENTION') AND ticker NOT LIKE '%DURATION%'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT t.ticker, m.event_ticker, t.taker_side, t.created_time::TIMESTAMPTZ AS ts, m.close_time,
      (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) / 100.0 AS p, (m.result = t.taker_side)::INT AS win
    FROM read_parquet({TRADES!r}) t JOIN m ON m.ticker = t.ticker
    WHERE t.taker_side IN ('yes', 'no') AND t.created_time::TIMESTAMPTZ < m.close_time),
  d AS (
    SELECT ticker, event_ticker, taker_side, date_trunc('day', ts) AS day, arg_min(p, ts) AS p, any_value(win) AS win,
      epoch(any_value(close_time) - min(ts)) / 3600.0 AS hours, min(ts) AS ts
    FROM t GROUP BY ALL)
  SELECT event_ticker, regexp_extract(ticker, '^([A-Z0-9]+)', 1) AS series, taker_side, substr(min(ts)::VARCHAR, 1, 10) AS first_day,
    CASE WHEN p < 0.06 THEN '01-05c' WHEN p < 0.11 THEN '06-10c' WHEN p < 0.21 THEN '11-20c' WHEN p < 0.36 THEN '21-35c' WHEN p < 0.51 THEN '36-50c'
         WHEN p < 0.66 THEN '51-65c' WHEN p < 0.81 THEN '66-80c' WHEN p < 0.91 THEN '81-90c' ELSE '91-99c' END AS band,
    CASE WHEN hours < 1 THEN '1: last hour' WHEN hours < 6 THEN '2: 1-6 h' WHEN hours < 24 THEN '3: 6-24 h' ELSE '4: over a day' END AS ttc,
    count(*) AS n, sum(win) AS wins, sum(p) AS paid, sum(win - p - 0.07 * p * (1 - p)) AS pnl
  FROM d GROUP BY ALL""").fetchall()
COLS = ['event', 'series', 'side', 'day', 'band', 'ttc', 'n', 'wins', 'paid', 'pnl']
R = [dict(zip(COLS, r)) for r in rows]
events = sorted({(min(r['day'] for r in R if r['event'] == e), e) for e in {r['event'] for r in R}})
half = {e: i >= len(events) // 2 for i, (_, e) in enumerate(events)}
print('copied trades', sum(r['n'] for r in R), 'events', len(events), 'second half starts', events[len(events) // 2][0])
random.seed(9)

def show(name, rs, pad=30):
    by = {}
    for r in rs:
        e = by.setdefault(r['event'], [0, 0.0, 0, 0.0]); e[0] += r['n']; e[1] += r['pnl']; e[2] += r['wins']; e[3] += r['paid']
    ev = list(by.values()); n = sum(e[0] for e in ev)
    if n < 150 or len(ev) < 25: return
    means = []
    for _ in range(800):
        s = random.choices(ev, k=len(ev)); means.append(100 * sum(e[1] for e in s) / sum(e[0] for e in s))
    means.sort()
    h = lambda late: [r for r in rs if half[r['event']] == late]
    part = lambda q: f"{100 * sum(r['pnl'] for r in q) / max(1, sum(r['n'] for r in q)):6.2f}c (n {sum(r['n'] for r in q):>5})"
    print(f"  {name.ljust(pad)} n {n:>6} events {len(ev):>4} | paid {100 * sum(e[3] for e in ev) / n:5.1f}c won {100 * sum(e[2] for e in ev) / n:5.1f}% | {100 * sum(e[1] for e in ev) / n:6.2f}c a contract ({means[20]:6.2f} to {means[779]:6.2f}) | halves {part(h(False))} / {part(h(True))}")

BANDS = ['01-05c', '06-10c', '11-20c', '21-35c', '36-50c', '51-65c', '66-80c', '81-90c', '91-99c']
for side in ['yes', 'no']:
    print(f'\nCopying takers who bought {side.upper()}, by price paid:')
    show('all prices', [r for r in R if r['side'] == side])
    for b in BANDS: show(b, [r for r in R if r['side'] == side and r['band'] == b])
for side in ['yes', 'no']:
    print(f'\nCopying takers who bought {side.upper()}, by hours to the close:')
    for t in sorted({r['ttc'] for r in R}): show(t, [r for r in R if r['side'] == side and r['ttc'] == t])
print('\nBuying NO at 66c or more (the "he will not say it" favorite), by hours to the close:')
for t in sorted({r['ttc'] for r in R}): show(t, [r for r in R if r['side'] == 'no' and r['band'] >= '66' and r['ttc'] == t])
print('\nBuying YES at 35c or less (the cheap "he will say it"), by hours to the close:')
for t in sorted({r['ttc'] for r in R}): show(t, [r for r in R if r['side'] == 'yes' and r['band'] <= '21-35c' and r['ttc'] == t])
print('\nBuying YES at 35c or less, by series (25 events or more):')
for s in sorted({r['series'] for r in R}): show(s, [r for r in R if r['side'] == 'yes' and r['band'] <= '21-35c' and r['series'] == s])
