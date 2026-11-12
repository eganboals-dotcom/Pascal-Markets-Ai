# Samples for the longshot test on the Becker dataset (scripts/becker-longshot.js): .venv/Scripts/python -I
# scripts/becker-longshot-samples.py [hours before close, default 2] [data/becker]. For each settled Kalshi market with at least
# 1,000 contracts traded (multi-game combos left out), the book is read H hours before close from its trades: the last trade a
# Yes buyer took is the ask, the last one a Yes seller took is the bid, each from the hour before. The exit price is the last
# buy and last sell in the two hours up to an hour later, averaged. Markets closing on or after 2025-11-25 are left out, so nothing overlaps the
# project's own Kalshi history. Writes <dir>/longshot-samples-<H>h.jsonl, one market a line. Research only.
import glob, sys
import duckdb

hours = float(sys.argv[1]) if len(sys.argv) > 1 else 2
root = sys.argv[2] if len(sys.argv) > 2 else 'data/becker'
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
if not MARKETS or not TRADES:
    sys.exit('No Becker Kalshi Parquet files found; run scripts/becker-download.js first')
out = f'{root}/longshot-samples-{hours:g}h.jsonl'

db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")  # so the close date below is the UTC date
db.execute(f"""COPY (
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time,
           close_time - INTERVAL ({int(hours * 60)}) MINUTE AS read_at, close_time - INTERVAL ({int(hours * 60) - 60}) MINUTE AS exit_at
    FROM (SELECT * REPLACE (close_time::TIMESTAMPTZ AS close_time) FROM read_parquet({MARKETS!r}))  -- stored as TIMESTAMPTZ_NS
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume >= 1000 AND ticker NOT LIKE 'KXMVE%'
      AND close_time < TIMESTAMPTZ '2025-11-25 00:00:00+00'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT m.ticker, t.created_time, t.yes_price, t.taker_side, m.read_at, m.exit_at
    FROM m JOIN (SELECT ticker, created_time::TIMESTAMPTZ AS created_time, yes_price, taker_side FROM read_parquet({TRADES!r})) t
      ON t.ticker = m.ticker
    WHERE t.created_time >= m.read_at - INTERVAL 1 HOUR AND t.created_time <= m.exit_at),
  b AS (
    SELECT ticker,
      arg_max(yes_price, created_time) FILTER (WHERE taker_side = 'yes' AND created_time <= read_at) / 100.0 AS yesAsk,
      arg_max(yes_price, created_time) FILTER (WHERE taker_side = 'no' AND created_time <= read_at) / 100.0 AS yesBid,
      (arg_max(yes_price, created_time) FILTER (WHERE taker_side = 'yes' AND created_time > exit_at - INTERVAL 2 HOUR)
       + arg_max(yes_price, created_time) FILTER (WHERE taker_side = 'no' AND created_time > exit_at - INTERVAL 2 HOUR)) / 200.0 AS exitMid
    FROM t GROUP BY ticker)
  SELECT m.ticker, m.event_ticker AS event, substr(m.close_time::VARCHAR, 1, 10) AS day, (m.result = 'yes')::INT AS settle,
         b.yesBid, b.yesAsk, b.exitMid
  FROM m JOIN b USING (ticker)
  WHERE b.yesBid IS NOT NULL AND b.yesAsk IS NOT NULL AND b.yesBid < b.yesAsk
  ORDER BY day, ticker
) TO '{out}' (FORMAT JSON)""")
print(out, db.execute(f"SELECT count(*), count(DISTINCT event), min(day), max(day) FROM read_json('{out}')").fetchone())
