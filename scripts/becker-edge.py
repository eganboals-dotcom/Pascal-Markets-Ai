# Is there a small edge that repeats? A search of the Becker dataset (every Kalshi trade, July 2021 to Nov 2025) that finds on
# one stretch of time and checks on a later one, so a lucky cell can't pass by being looked at. Same markets as becker-flow.py:
# settled, 1,000 contracts or more, parlays (KXMVE) left out. A cell is one group (a category, or one series such as KXHIGHNY),
# the side the taker bought, the price in 10c steps and the hours to close; all four are known before an order goes in.
# Each cell is read two ways: "taker" buys that side at that price and pays Kalshi's taker fee, 0.07 x C x P x (1 - P) rounded
# up per trade; "maker" is the resting order on the other end, which sells that side at that price and pays the worst-case maker
# fee, 0.0175 x C x P x (1 - P) rounded up per trade. Either way, a bot takes min(count, 10) of every trade, held to settlement.
# Rules, fixed before the first run:
#   find  = trades before June 2025; a cell is a candidate with 100 or more events and trading days, its 95% range above 0 after fee;
#   check = trades from June 2025 on; a candidate passes with 30 or more events and trading days, its 95% range above 0 after fee.
# Ranges are a cluster-robust standard error of the ratio, the wider of two: each UTC day as one draw (an edge has to show up day
# after day) and each event as one draw (a market open for months settles once). The first run used days only, and long-dated
# futures passed on a single outcome repeated across their days; events were added after seeing that. By chance alone, about 2.5% of candidates would pass. Taker results assume the bot got the same price
# at the same moment; maker results assume it was first in line, an upper bound. Writes data/becker/edge-report.json and .md.
# Read-only:
#   .venv/Scripts/python -I scripts/becker-edge.py <temp dir>
import glob, json, math, sys
import duckdb

root = 'data/becker'  # run from the project root
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
if not MARKETS or not TRADES:
    sys.exit('No Becker Kalshi Parquet files under data/becker')
FIND_DAYS, CHECK_DAYS = 100, 30
db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")
db.execute("SET memory_limit = '10GB'")
db.execute(f"SET temp_directory = '{sys.argv[1]}'")
fee = lambda rate: f'ceil({rate} * n * p * (1 - p) - 1e-9) / 100'  # dollars per trade, rounded up to the cent
db.execute(f"""CREATE TEMP TABLE d AS
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time::TIMESTAMPTZ AS close_time
    FROM read_parquet({MARKETS!r})
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume >= 1000 AND ticker NOT LIKE 'KXMVE%'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT split_part(m.event_ticker, '-', 1) AS series, m.event_ticker AS ev, t.taker_side AS side, least(t.count, 10) AS n,
      t.created_time::TIMESTAMPTZ AS ts,
      (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) / 100.0 AS p,
      (m.result = t.taker_side)::INT AS win, epoch(m.close_time - t.created_time::TIMESTAMPTZ) / 3600.0 AS hours
    FROM read_parquet({TRADES!r}) t JOIN m ON m.ticker = t.ticker
    WHERE t.taker_side IN ('yes', 'no') AND t.created_time::TIMESTAMPTZ < m.close_time AND t.count > 0)
  SELECT series,
    CASE WHEN regexp_matches(series, '^(KX)?(BTC|ETH|SOL|XRP|DOGE)') THEN 'crypto'
         WHEN regexp_matches(series, '^(KX)?(INX|NASDAQ|SP500|WTI|GOLD|USDJPY|EURUSD|TNOTE)') THEN 'markets'
         WHEN regexp_matches(series, '^(KX)?(HIGH|LOW|RAIN|SNOW|TEMP|HURR|TORNADO)') THEN 'weather'
         WHEN regexp_matches(series, '^(KX)?(PRES|POPVOTE|ECMOV|SENATE|HOUSE|GOV|MAYOR|FED|CPI|GDP|PAYROLLS|UNEMP|RATECUT|SHUTDOWN|TRUMP|CABINET|SCOTUS|APPROVE|ELECTION|EC[A-Z])') THEN 'politics-econ'
         WHEN regexp_matches(series, '^(KX)?(NFL|NBA|MLB|NHL|NCAA|WNBA|MARMAD|WMARMAD|UFC|ATP|WTA|PGA|MASTERS|USOPEN|THEOPEN|WMENSINGLES|EPL|UCL|LALIGA|BUNDESLIGA|SERIEA|LIGUE|MLS|F1|NASCAR|FIFA|SOCCER|TENNIS|GOLF|BOX|WIMBLEDON|FRENCHOPEN|AUSOPEN|CS2|LOL|VALORANT|DOTA|CRICKET|IPL)') THEN 'sports'
         ELSE 'other' END AS cat,
    side, least(floor(p * 10), 9)::INT AS dec,
    CASE WHEN hours < 1 THEN '1: last hour' WHEN hours < 6 THEN '2: 1-6 h' WHEN hours < 24 THEN '3: 6-24 h' WHEN hours < 168 THEN '4: 1-7 days' ELSE '5: over 7 days' END AS ttc,
    ts >= TIMESTAMPTZ '2025-06-01 00:00:00+00' AS late, ts::DATE AS day, ev,
    sum(n) AS c, sum(n * win) AS w, sum(n * p) AS pc, sum(n * (win - p)) AS g, sum({fee(7)}) AS ft, sum({fee(1.75)}) AS fm
  FROM t GROUP BY ALL""")


def stats(level):
    """Per cell and period: trading days, contracts, the taker's win rate and price, and both roles' result a contract after fee."""
    keys = 'k, side, dec, ttc, late'
    spread = lambda by: f"""(SELECT {keys}, sqrt(sum((b.xt - r.rt * b.c) ^ 2)) AS st, sqrt(sum((b.xm - r.rm * b.c) ^ 2)) AS sm
                             FROM (SELECT {keys}, {by}, sum(c) AS c, sum(xt) AS xt, sum(xm) AS xm FROM base GROUP BY ALL) b
                             JOIN r USING ({keys}) GROUP BY ALL)"""
    return db.execute(f"""WITH base AS (SELECT {level} AS k, side, dec, ttc, late, day, ev, c, w, pc, ft, fm, g - ft AS xt, -g - fm AS xm FROM d),
        r AS (SELECT {keys}, count(DISTINCT day) AS days, count(DISTINCT ev) AS events, sum(c) AS c, sum(w) / sum(c) AS win,
                sum(pc) / sum(c) AS price, sum(ft) / sum(c) AS ft, sum(fm) / sum(c) AS fm, sum(xt) / sum(c) AS rt, sum(xm) / sum(c) AS rm
              FROM base GROUP BY ALL)
      SELECT {keys}, days, events, c, win, price, ft, fm, rt, rm, bd.st, bd.sm, be.st, be.sm
      FROM r JOIN {spread('day')} bd USING ({keys}) JOIN {spread('ev')} be USING ({keys})""").fetchall()


cells = {}
for level in ('cat', 'series'):
    for k, side, dec, ttc, late, days, events, c, win, price, ft, fm, rt, rm, dt, dm, et, em in stats(level):
        assert 0 <= win <= 1 and abs(rt + rm + ft + fm) < 1e-9  # the two roles mirror each other, less both fees
        adj = lambda n: math.sqrt(n / (n - 1)) if n > 1 else float('inf')
        wider = lambda by_day, by_event: max(by_day * adj(days), by_event * adj(events)) / c
        for role, r, se, w, need in (('taker', rt, wider(dt, et), win, price + ft), ('maker', rm, wider(dm, em), 1 - win, 1 - price + fm)):
            cells.setdefault((level, k, side, dec, ttc, role), {})[late] = dict(
                days=days, events=events, contracts=int(c), cents=round(100 * r, 2), low=round(100 * (r - 1.96 * se), 2),
                high=round(100 * (r + 1.96 * se), 2), win=round(100 * w, 2), needed=round(100 * need, 2))

enough = lambda s, n: min(s['days'], s['events']) >= n
found = [k for k, v in cells.items() if False in v and enough(v[False], FIND_DAYS) and v[False]['low'] > 0]
checkable = [k for k in found if True in cells[k] and enough(cells[k][True], CHECK_DAYS)]
passed = [k for k in checkable if cells[k][True]['low'] > 0]
per_day = lambda k: cells[k][True]['cents'] * cells[k][True]['contracts'] / cells[k][True]['days'] / 100  # dollars at 10 a trade
passed.sort(key=per_day, reverse=True)
name = lambda k: dict(level=k[0], group=k[1], taker_bought=k[2], price=f'{10 * k[3]}-{10 * k[3] + 9}c', hours_to_close=k[4][3:], role=k[5])
report = dict(markets='settled, 1,000+ contracts, no parlays', find='before June 2025', check='June 2025 on', cells=len(cells),
              candidates=len(found), checkable=len(checkable), passed=len(passed), by_chance=round(0.025 * len(checkable), 1),
              results=[name(k) | dict(find=cells[k][False], check=cells[k].get(True), dollars_a_day_at_10=round(per_day(k), 2) if k in passed else None)
                       for k in found])
with open(f'{root}/edge-report.json', 'w', encoding='utf-8') as f:
    json.dump(report, f, indent=2)

cell = lambda s: f"{s['cents']:+.2f}¢ ({s['low']:+.2f} to {s['high']:+.2f})"
lines = ['# Small edges on Kalshi that repeat, found before June 2025 and checked after', '',
         f"Research only. {len(cells)} cells read, {len(found)} candidates found, {len(checkable)} with enough later days to check, "
         f"{len(passed)} passed (about {report['by_chance']} would pass by chance). Cents a contract after fee; ranges are 95%, by day or by event, whichever is wider.",
         'Win rate is the bot\'s, beside the rate it needs to break even after fee. Dollars a day assume 10 contracts of every trade.', '',
         '| Level | Group | Taker bought | Price | Hours to close | Role | Found | Checked | Win vs needed | Events / days | $ a day |',
         '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
for k in passed:
    n, a, b = name(k), cells[k][False], cells[k][True]
    lines.append(f"| {n['level']} | {n['group']} | {n['taker_bought']} | {n['price']} | {n['hours_to_close']} | {n['role']} | {cell(a)} | "
                 f"{cell(b)} | {b['win']:.2f}% vs {b['needed']:.2f}% | {b['events']} / {b['days']} | {per_day(k):,.2f} |")
with open(f'{root}/edge-report.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print('\n'.join(lines))
