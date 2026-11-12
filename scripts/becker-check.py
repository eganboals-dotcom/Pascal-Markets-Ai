# Is the unpacked Becker dataset real Kalshi data? Run by scripts/becker-download.js after the unpack, with the project's .venv
# (DuckDB): .venv/Scripts/python -I scripts/becker-check.py [data/becker]. It reads the Kalshi markets and trades Parquet files,
# checks their columns and date range, then compares a seeded random sample of 25 settled markets with Kalshi's own public API
# (title, result, volume) and, for 5 of them, Kalshi's latest trades with the dataset's trade ids. One request a second, no key.
# Writes <dir>/check-report.json and exits 1 when the data fails the check. Research only.
import glob, json, sys, time, urllib.error, urllib.request
import duckdb

root = sys.argv[1] if len(sys.argv) > 1 else 'data/becker'
API = 'https://api.elections.kalshi.com/trade-api/v2'
MARKETS = glob.glob(f'{root}/**/kalshi/markets/*.parquet', recursive=True)
TRADES = glob.glob(f'{root}/**/kalshi/trades/*.parquet', recursive=True)
NEED_MARKET = {'ticker', 'event_ticker', 'title', 'status', 'result', 'volume', 'close_time'}
NEED_TRADE = {'trade_id', 'ticker', 'count', 'yes_price', 'taker_side', 'created_time'}


def get(path):
    """Kalshi public JSON, trying the historical endpoint when the live one no longer has the market."""
    for base in (API, f'{API}/historical'):
        time.sleep(1)
        request = urllib.request.Request(base + path, headers={'User-Agent': 'pascal-markets-research'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    return None


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


report = {'markets_files': len(MARKETS), 'trades_files': len(TRADES)}
if not MARKETS or not TRADES:
    report['pass'] = False
    report['problem'] = 'No Kalshi markets or trades Parquet files found'
else:
    db = duckdb.connect()
    m, t = f"read_parquet({MARKETS!r})", f"read_parquet({TRADES!r})"
    market_cols = {r[0] for r in db.execute(f'DESCRIBE SELECT * FROM {m}').fetchall()}
    trade_cols = {r[0] for r in db.execute(f'DESCRIBE SELECT * FROM {t}').fetchall()}
    report['missing_columns'] = sorted((NEED_MARKET - market_cols) | (NEED_TRADE - trade_cols))
    report['markets'], report['first_close'], report['last_close'] = map(str, db.execute(f'SELECT count(*), min(close_time), max(close_time) FROM {m}').fetchone())
    report['trades'], report['contracts'], report['first_trade'], report['last_trade'] = map(str, db.execute(
        f'SELECT count(*), sum("count"), min(created_time), max(created_time) FROM {t}').fetchone())
    sample = db.execute(f"""SELECT ticker, title, result, volume FROM {m}
        WHERE status = 'finalized' AND result IN ('yes', 'no') AND volume > 1000 AND close_time < TIMESTAMP '2026-01-01'
        USING SAMPLE reservoir(25 ROWS) REPEATABLE (42)""").fetchall()
    checked = []
    for ticker, title, result, volume in sample:
        try:
            live = (get(f'/markets/{ticker}') or {}).get('market')
        except Exception as error:  # a network failure is reported, not counted as a mismatch
            checked.append({'ticker': ticker, 'error': str(error)})
            continue
        if not live:
            checked.append({'ticker': ticker, 'unavailable': True})
            continue
        kalshi_volume = number(live.get('volume_fp', live.get('volume')))
        checked.append({'ticker': ticker, 'title': live.get('title') == title, 'result': live.get('result') == result,
                        'volume': kalshi_volume is not None and abs(kalshi_volume - volume) <= max(1, 0.01 * volume)})
    compared = [c for c in checked if 'result' in c]
    report['sample'] = checked
    report['markets_agreeing'] = sum(c['result'] and c['title'] for c in compared)
    report['markets_compared'] = len(compared)
    # Kalshi's latest page of trades for 5 sampled markets, against the dataset's trades for them.
    tickers = [c['ticker'] for c in compared][:5]
    ids = {}
    if tickers:
        for ticker, trade_id in db.execute(f'SELECT ticker, trade_id FROM {t} WHERE ticker IN (SELECT unnest(?))', [tickers]).fetchall():
            ids.setdefault(ticker, set()).add(trade_id)
    overlap = []
    for ticker in tickers:
        try:
            page = (get(f'/markets/trades?ticker={ticker}&limit=100') or {}).get('trades') or []
        except Exception as error:
            overlap.append({'ticker': ticker, 'error': str(error)})
            continue
        if page:
            overlap.append({'ticker': ticker, 'kalshi': len(page), 'in_dataset': sum(p.get('trade_id') in ids.get(ticker, set()) for p in page)})
    report['trade_overlap'] = overlap
    seen = sum(o.get('kalshi', 0) for o in overlap)
    found = sum(o.get('in_dataset', 0) for o in overlap)
    report['pass'] = (not report['missing_columns'] and len(compared) >= 10 and report['markets_agreeing'] >= 0.9 * len(compared)
                      and (seen == 0 or found >= 0.9 * seen))

with open(f'{root}/check-report.json', 'w', encoding='utf-8') as f:
    json.dump(report, f, indent=2)
print(json.dumps({k: v for k, v in report.items() if k not in ('sample', 'trade_overlap')}))
sys.exit(0 if report['pass'] else 1)
