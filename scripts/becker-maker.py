# What did the resting orders earn? On the Becker dataset (every Kalshi trade, July 2021 to Nov 2025), every trade has a maker:
# the resting order the taker hit. The maker sold the taker's side at the taker's price p, so it makes p - win a contract,
# held to settlement. The maker fee is charged on every trade at its worst case, Kalshi's 0.0175 x C x P x (1 - P) rounded up
# to the cent per trade, although most markets charge makers nothing. Same markets as becker-flow.py: settled, 1,000 contracts
# or more, parlays (KXMVE, quoted by request) left out. Two views: "all" is the whole maker side, contract-weighted; "q10" is a
# bot quoting 10 contracts first in line, so it takes min(count, 10) of every trade, an upper bound since real quotes queue.
# Tests, fixed before the first run; a category passes only with all three:
#   1. all, after the fee, earns more than 0 a contract with its 95% range by event above 0;
#   2. q10, after the fee, the same;
#   3. q10, after the fee, earns more than 0 both before June 2025 and from June 2025 on.
# Ranges treat each event as one draw (a cluster-robust standard error of the ratio). Price and hours-to-close tables are
# shown for q10 without tests. Writes data/becker/maker-report.json and .md. Read-only:
#   .venv/Scripts/python -I scripts/becker-maker.py <temp dir>
import glob, json, math, sys
import duckdb

root = 'data/becker'  # run from the project root
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
if not MARKETS or not TRADES:
    sys.exit('No Becker Kalshi Parquet files under data/becker')
db = duckdb.connect()
db.execute("SET TimeZone = 'UTC'")
db.execute("SET memory_limit = '10GB'")
db.execute(f"SET temp_directory = '{sys.argv[1]}'")
fee = lambda c: f'ceil(1.75 * {c} * p * (1 - p) - 1e-9) / 100'  # dollars per trade, rounded up to the cent
db.execute(f"""CREATE TEMP TABLE e AS
  WITH m AS (
    SELECT DISTINCT ON (ticker) ticker, event_ticker, result, close_time::TIMESTAMPTZ AS close_time
    FROM read_parquet({MARKETS!r})
    WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume >= 1000 AND ticker NOT LIKE 'KXMVE%'
    ORDER BY ticker, _fetched_at DESC),
  t AS (
    SELECT t.ticker, m.event_ticker, t.count AS n, least(t.count, 10) AS n10, t.created_time::TIMESTAMPTZ AS ts,
      (CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END) / 100.0 AS p,
      (m.result = t.taker_side)::INT AS win, epoch(m.close_time - t.created_time::TIMESTAMPTZ) / 3600.0 AS hours
    FROM read_parquet({TRADES!r}) t JOIN m ON m.ticker = t.ticker
    WHERE t.taker_side IN ('yes', 'no') AND t.created_time::TIMESTAMPTZ < m.close_time AND t.count > 0)
  SELECT event_ticker, ts >= TIMESTAMPTZ '2025-06-01 00:00:00+00' AS late,
    CASE WHEN regexp_matches(ticker, '^(KX)?(BTC|ETH|SOL|XRP|DOGE)') THEN 'crypto'
         WHEN regexp_matches(ticker, '^(KX)?(INX|NASDAQ|SP500|WTI|GOLD|USDJPY|EURUSD|TNOTE)') THEN 'markets'
         WHEN regexp_matches(ticker, '^(KX)?(HIGH|LOW|RAIN|SNOW|TEMP|HURR|TORNADO)') THEN 'weather'
         WHEN regexp_matches(ticker, '^(KX)?(PRES|POPVOTE|ECMOV|SENATE|HOUSE|GOV|MAYOR|FED|CPI|GDP|PAYROLLS|UNEMP|RATECUT|SHUTDOWN|TRUMP|CABINET|SCOTUS|APPROVE|ELECTION|EC[A-Z])') THEN 'politics-econ'
         WHEN regexp_matches(ticker, '^(KX)?(NFL|NBA|MLB|NHL|NCAA|WNBA|MARMAD|WMARMAD|UFC|ATP|WTA|PGA|MASTERS|USOPEN|THEOPEN|WMENSINGLES|EPL|UCL|LALIGA|BUNDESLIGA|SERIEA|LIGUE|MLS|F1|NASCAR|FIFA|SOCCER|TENNIS|GOLF|BOX|WIMBLEDON|FRENCHOPEN|AUSOPEN|CS2|LOL|VALORANT|DOTA|CRICKET|IPL)') THEN 'sports'
         ELSE 'other' END AS cat,
    CASE WHEN hours < 1 THEN '1: last hour' WHEN hours < 6 THEN '2: 1-6 h' WHEN hours < 24 THEN '3: 6-24 h' WHEN hours < 168 THEN '4: 1-7 days' ELSE '5: over 7 days' END AS ttc,
    CASE WHEN p < 0.2 THEN '1: under 20c' WHEN p < 0.5 THEN '2: 20-49c' WHEN p < 0.8 THEN '3: 50-79c' ELSE '4: 80c+' END AS price,
    count(*) AS trades, sum(n) AS c, sum(n * (p - win)) - sum({fee('n')}) AS x, sum(n * (p - win)) AS gross,
    sum(n10) AS c10, sum(n10 * (p - win)) - sum({fee('n10')}) AS x10, sum(n10 * (p - win)) AS gross10
  FROM t GROUP BY ALL""")


def ratio(by, where='TRUE', view=''):
    """Per group: events, contracts, cents a contract after the fee, its 95% range by event, and before the fee."""
    c, x, g = f'c{view}', f'x{view}', f'gross{view}'
    keys = ', '.join(by)
    rows = db.execute(f"""WITH ev AS (SELECT {keys}, event_ticker, sum({c}) AS c, sum({x}) AS x, sum({g}) AS g
                                      FROM e WHERE {where} GROUP BY ALL),
                          r AS (SELECT {keys}, sum(x) / sum(c) AS r FROM ev GROUP BY ALL)
      SELECT {', '.join(f'ev.{k}' for k in by)}, count(*) AS k, sum(ev.c) AS c, any_value(r.r) AS r, sum(ev.g) / sum(ev.c) AS g,
        sqrt(sum((ev.x - r.r * ev.c) ^ 2)) / sum(ev.c) AS se
      FROM ev JOIN r USING ({keys}) GROUP BY ALL ORDER BY ALL""").fetchall()
    out = []
    for row in rows:
        *key, k, n, r, g, se = row
        se = se * math.sqrt(k / (k - 1)) if k > 1 else float('inf')
        out.append(dict(zip(by, key)) | dict(events=k, contracts=int(n), cents=round(100 * r, 2), low=round(100 * (r - 1.96 * se), 2),
                                            high=round(100 * (r + 1.96 * se), 2), before_fee=round(100 * g, 2)))
    return out


def by_cat(rows):
    return {r['cat']: r for r in rows}


every, q10 = by_cat(ratio(['cat'])), by_cat(ratio(['cat'], view='10'))
early, late = by_cat(ratio(['cat'], 'NOT late', '10')), by_cat(ratio(['cat'], 'late', '10'))
verdict = {}
for cat in sorted(every):
    t1 = every[cat]['low'] > 0
    t2 = q10[cat]['low'] > 0
    t3 = cat in early and cat in late and early[cat]['cents'] > 0 and late[cat]['cents'] > 0
    verdict[cat] = dict(test1=t1, test2=t2, test3=t3, passed=t1 and t2 and t3)
report = dict(markets='settled, 1,000+ contracts, no parlays', fee='0.0175 x C x P x (1-P), rounded up per trade, on every trade',
              all=every, q10=q10, q10_before_june_2025=early, q10_from_june_2025=late, verdict=verdict,
              q10_by_price=ratio(['cat', 'price'], view='10'), q10_by_hours_to_close=ratio(['cat', 'ttc'], view='10'))
with open(f'{root}/maker-report.json', 'w', encoding='utf-8') as f:
    json.dump(report, f, indent=2)

cell = lambda r: f"{r['cents']:+.2f}¢ ({r['low']:+.2f} to {r['high']:+.2f})"
lines = ['# What resting orders earned on Kalshi, July 2021 to Nov 2025', '',
         'Research only. Cents a contract to the maker, held to settlement, after the worst-case maker fee. "All" is the whole maker',
         'side, weighted by contracts; "10 first in line" takes up to 10 contracts of every trade, an upper bound for a small bot.',
         'Ranges are 95%, by event.', '',
         '| Category | Events | All | Before fee | 10 first in line | Before June 2025 | From June 2025 | Passes |',
         '| --- | --- | --- | --- | --- | --- | --- | --- |']
for cat in sorted(every):
    a, q = every[cat], q10[cat]
    half = lambda d: f"{d[cat]['cents']:+.2f}¢" if cat in d else 'n/a'
    lines.append(f"| {cat} | {a['events']} | {cell(a)} | {a['before_fee']:+.2f}¢ | {cell(q)} | {half(early)} | {half(late)} | "
                 f"{'yes' if verdict[cat]['passed'] else 'no'} |")
for title, key, col in (('price the taker paid', 'q10_by_price', 'price'), ('hours to close', 'q10_by_hours_to_close', 'ttc')):
    lines += ['', f'## 10 first in line, by {title}', '', f'| Category | {title.capitalize()} | Events | Cents a contract |', '| --- | --- | --- | --- |']
    lines += [f"| {r['cat']} | {r[col][3:]} | {r['events']} | {cell(r)} |" for r in report[key] if r['events'] >= 30]
with open(f'{root}/maker-report.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print('\n'.join(lines))
