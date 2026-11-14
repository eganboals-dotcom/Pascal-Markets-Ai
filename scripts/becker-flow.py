# Does following large trades pay? On the Becker dataset (every Kalshi trade, July 2021 to Nov 2025), each trade is a signal:
# the taker bought Yes or No at a price. "taker" is the taker's own result per contract after a 7% taker fee, held to
# settlement. "follow" is a follower's result: buying the same side at the price of the NEXT trade on that side in the same
# market within 10 minutes (a price that really traded after the signal), same fee, held to settlement. One vote per signal.
# Cells: category x trade size x hours to close. Each half of the data is shown apart, so a cell that is luck shows up. Read-only.
import glob, sys
import duckdb

root = 'data/becker'  # run from the project root
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")
db.execute("SET memory_limit = '10GB'")
db.execute(f"SET temp_directory = '{sys.argv[1]}'")
db.execute(f"""CREATE TEMP TABLE s AS
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time::TIMESTAMPTZ AS close_time
    FROM read_parquet({MARKETS!r})
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume >= 1000 AND ticker NOT LIKE 'KXMVE%'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT t.ticker, m.event_ticker, t.count AS n, t.taker_side, t.created_time::TIMESTAMPTZ AS ts,
      (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) / 100.0 AS p,
      (m.result = t.taker_side)::INT AS win, epoch(m.close_time - t.created_time::TIMESTAMPTZ) / 3600.0 AS hours
    FROM read_parquet({TRADES!r}) t JOIN m ON m.ticker = t.ticker
    WHERE t.taker_side IN ('yes', 'no') AND t.created_time::TIMESTAMPTZ < m.close_time),
  w AS (
    SELECT *, lead(p) OVER x AS p2, lead(ts) OVER x AS at2 FROM t WINDOW x AS (PARTITION BY ticker, taker_side ORDER BY ts))
  SELECT event_ticker, n, p, win, hours, ts >= TIMESTAMPTZ '2025-06-01 00:00:00+00' AS late,
    CASE WHEN regexp_matches(ticker, '^(KX)?(BTC|ETH|SOL|XRP|DOGE)') THEN 'crypto'
         WHEN regexp_matches(ticker, '^(KX)?(INX|NASDAQ|SP500|WTI|GOLD|USDJPY|EURUSD|TNOTE)') THEN 'markets'
         WHEN regexp_matches(ticker, '^(KX)?(HIGH|LOW|RAIN|SNOW|TEMP|HURR|TORNADO)') THEN 'weather'
         WHEN regexp_matches(ticker, '^(KX)?(PRES|POPVOTE|ECMOV|SENATE|HOUSE|GOV|MAYOR|FED|CPI|GDP|PAYROLLS|UNEMP|RATECUT|SHUTDOWN|TRUMP|CABINET|SCOTUS|APPROVE|ELECTION|EC[A-Z])') THEN 'politics-econ'
         WHEN regexp_matches(ticker, '^(KX)?(NFL|NBA|MLB|NHL|NCAA|WNBA|MARMAD|WMARMAD|UFC|ATP|WTA|PGA|MASTERS|USOPEN|THEOPEN|WMENSINGLES|EPL|UCL|LALIGA|BUNDESLIGA|SERIEA|LIGUE|MLS|F1|NASCAR|FIFA|SOCCER|TENNIS|GOLF|BOX|WIMBLEDON|FRENCHOPEN|AUSOPEN|CS2|LOL|VALORANT|DOTA|CRICKET|IPL)') THEN 'sports'
         ELSE 'other' END AS cat,
    CASE WHEN n < 10 THEN '1: 1-9' WHEN n < 100 THEN '2: 10-99' WHEN n < 1000 THEN '3: 100-999' WHEN n < 10000 THEN '4: 1k-10k' ELSE '5: 10k+' END AS size,
    CASE WHEN hours < 1 THEN '1: last hour' WHEN hours < 6 THEN '2: 1-6 h' WHEN hours < 24 THEN '3: 6-24 h' WHEN hours < 168 THEN '4: 1-7 days' ELSE '5: over 7 days' END AS ttc,
    CASE WHEN p < 0.2 THEN '1: under 20c' WHEN p < 0.5 THEN '2: 20-49c' WHEN p < 0.8 THEN '3: 50-79c' ELSE '4: 80c+' END AS price,
    win - p - 0.07 * p * (1 - p) AS taker,
    CASE WHEN p2 IS NOT NULL AND at2 > ts AND at2 <= ts + INTERVAL 10 MINUTE THEN win - p2 - 0.07 * p2 * (1 - p2) END AS follow
  FROM w""")
print('signals', db.execute('SELECT count(*), count(follow) FROM s').fetchall())

def table(title, dims, where='TRUE', min_n=3000):
    print(f'\n{title}  (cents per contract, one vote per signal; early = before June 2025, late = after)')
    rows = db.execute(f"""SELECT {dims}, count(*) AS signals, count(DISTINCT event_ticker) AS events,
        100 * avg(taker) AS taker, count(follow) AS followed, 100 * avg(follow) AS follow,
        100 * avg(follow) FILTER (WHERE NOT late) AS early, count(follow) FILTER (WHERE NOT late) AS early_n,
        100 * avg(follow) FILTER (WHERE late) AS late, count(follow) FILTER (WHERE late) AS late_n
      FROM s WHERE {where} GROUP BY ALL HAVING count(follow) >= {min_n} ORDER BY ALL""").fetchall()
    f = lambda x: '   n/a' if x is None else f'{x:6.2f}'
    for r in rows:
        k = len(r) - 9
        print('  ' + ' | '.join(str(v).ljust(15) for v in r[:k]) + f' | signals {r[k]:>9} events {r[k+1]:>6} | taker {f(r[k+2])} | follow {f(r[k+4])} (n {r[k+3]:>8}) | early {f(r[k+5])} (n {r[k+6]:>8}) | late {f(r[k+7])} (n {r[k+8]:>8})')

table('By trade size', 'size')
table('By category and trade size', 'cat, size')
table('By category, trade size and hours to close, trades of 1,000 contracts or more', 'cat, size, ttc', "size >= '4'")
table('By category, size and price, trades of 1,000 contracts or more', 'cat, size, price', "size >= '4'")
