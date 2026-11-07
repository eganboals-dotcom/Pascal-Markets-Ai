"""Extract NBA moneyline order-book rows from the Pendulum Flow Polymarket archive (CC BY-NC 4.0).

For each UTC hour that overlaps a game in markets.json, downloads that hour's sports files one at a
time with a single request each, keeps only the rows for the games' outcome tokens, and deletes the
download. Writes one JSON Lines file per game. Usage:
  python scripts/archive_extract.py markets.json out-dir [local-dir]
With local-dir, reads <hour>.sports.parquet files from that folder instead of downloading.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import duckdb

BASE = "https://dl.pendulumflow.com/v3.1/"
AGENT = "pascal-markets-research (github.com/eganboals-dotcom/Pascal-Markets-Ai)"
HOUR = 3600000
PAUSE_S = 5  # between downloads, to stay well inside the archive's rate limits


def get(url, path=None):
    for attempt in range(6):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(request, timeout=600) as response:
                if path is None:
                    return response.read()
                with open(path, "wb") as f:
                    while chunk := response.read(1 << 20):
                        f.write(chunk)
                return path
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
            wait = int(error.headers.get("Retry-After") or 30) + 5 * attempt
            print(f"HTTP {error.code} for {url}, waiting {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"Gave up on {url}")


def hours_for(markets):
    hours = {}
    for m in markets:
        start = (m["startsAt"] - HOUR // 2) // HOUR * HOUR
        for t in range(start, m["resolvedAt"] + 1, HOUR):
            hours.setdefault(t, []).append(m)
    return dict(sorted(hours.items()))


DEPTH = 30  # shortcut: book snapshots keep the 30 levels nearest the top; a side emptied past them reads as no quote until the next snapshot


def levels(xs, bids):
    if xs is None:
        return None
    top = sorted(xs, key=lambda x: x["price"], reverse=bids)[:DEPTH]
    return [[float(x["price"]), float(x["size"])] for x in top]


num = lambda x: None if x is None else float(x)


def extract(con, path, games):
    # Model replay trades the home outcome only, so the away book is not needed.
    tokens = {format(int(m["homeAssetId"]), "064x"): m["gameId"] for m in games}
    hex_list = ",".join(f"from_hex('{h}')" for h in tokens)
    # Level changes more than 5 cents outside the best bid and ask cannot reach the top of the book
    # before the next snapshot (several per minute), so they are dropped to keep the output small.
    rows = con.execute(f"""
        SELECT hex(asset_id), event_type, epoch_ms(timestamp), epoch_ms(timestamp) + recv_lag_ms,
               bids, asks, price, size, side, best_bid, best_ask
        FROM read_parquet('{path}')
        WHERE asset_id IN ({hex_list}) AND event_type IN ('book', 'price_change', 'tick_size_change')
          AND (event_type <> 'price_change' OR best_bid IS NULL OR best_ask IS NULL
               OR price BETWEEN best_bid - 0.05 AND best_ask + 0.05)
        ORDER BY epoch_ms(timestamp) + recv_lag_ms, timestamp, row_ordinal""").fetchall()  # files group rows by event type; replay needs arrival order
    out = {}
    for asset, kind, source, received, bids, asks, price, size, side, bb, ba in rows:
        if kind == "book":
            row = ["b", source, received, levels(bids, True), levels(asks, False)]
        elif kind == "price_change":
            row = ["p", source, received, num(price), num(size), side, num(bb), num(ba)]
        else:
            row = ["t", source, received]
        out.setdefault(tokens[asset.lower()], []).append(row)
    return out


def main():
    markets_path, out_dir = sys.argv[1], sys.argv[2]
    local = sys.argv[3] if len(sys.argv) > 3 else None
    markets = json.load(open(markets_path))["markets"]
    os.makedirs(out_dir, exist_ok=True)
    con = duckdb.connect()
    coverage = []
    for t, games in hours_for(markets).items():
        hour = datetime.fromtimestamp(t / 1000, timezone.utc)
        name = hour.strftime("%Y-%m-%dT%H")
        folder = hour.strftime("%Y-%m-%d/%H/")
        if local:
            files = [os.path.join(local, f"{name}.sports.parquet")]
            files = [f for f in files if os.path.exists(f)]
        else:
            try:
                manifest = json.loads(get(BASE + folder + f"{name}.manifest.json"))
            except urllib.error.HTTPError as error:
                coverage.append({"hour": name, "missing": f"HTTP {error.code}"})
                continue
            files = [f["file"] for f in manifest["files"] if f["category"] == "sports" and f["role"] == "lean"]
        rows = 0
        for f in files:
            path = f if local else os.path.join(out_dir, "download.parquet")
            if not local:
                get(BASE + folder + f, path)
                time.sleep(PAUSE_S)
            for game_id, items in extract(con, path, games).items():
                rows += len(items)
                with open(os.path.join(out_dir, f"{game_id}.jsonl"), "a") as out:
                    out.write("".join(json.dumps(i, separators=(",", ":")) + "\n" for i in items))
            if not local:
                os.remove(path)
        coverage.append({"hour": name, "files": len(files), "games": len(games), "rows": rows})
        print(coverage[-1], flush=True)
    json.dump(coverage, open(os.path.join(out_dir, "coverage.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
