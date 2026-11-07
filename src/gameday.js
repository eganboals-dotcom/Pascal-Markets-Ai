// Public-data research scheduling; rounds are awaited so they never overlap.
import { fetchEvent } from './kalshi.js';
import { publicLookup } from './polymarket.js';
import { mapConcurrent } from './dryrun.js';
import { isHit, ladders, noBaskets, runScan, scanCrossVenue, track } from './scan.js';

export function selectWatchList(candidates, { events = [], pairs = [] } = {}, size = 20) {
  if (!Number.isInteger(size) || size < 0) throw new Error('Invalid watch size');
  const best = new Map();
  for (const c of candidates) {
    if (!c.event || !Array.isArray(c.checks) || c.checks.some(check => ['liquidity', 'notClosing', 'kalshiCertified'].includes(check))) continue;
    const edge = c.profit / c.contracts;
    if (c.contracts > 0 && Number.isFinite(edge) && (!best.has(c.event) || edge > best.get(c.event))) best.set(c.event, edge);
  }
  return [...best].map(([ticker, profitPerContract]) => {
    const event = events.find(e => e.event_ticker === ticker);
    const markets = event?.markets ?? [];
    return { ticker, profitPerContract,
      volume24h: markets.reduce((sum, m) => sum + (Number(m.volume_24h_fp) || 0), 0),
      pairs: pairs.filter(p => p.event?.event_ticker === ticker || markets.some(m => m.ticker === p.kalshiTicker)) };
  }).sort((a, b) => b.profitPerContract - a.profitPerContract || b.volume24h - a.volume24h || a.ticker.localeCompare(b.ticker)).slice(0, size);
}

export async function fastRound(config, watch, series, now = Date.now(), { loadEvent = fetchEvent, lookup = publicLookup() } = {}) {
  const errors = [];
  const fetched = await mapConcurrent(watch, 8, async entry => {
    try { return await loadEvent(entry.ticker); }
    catch (error) { errors.push({ event: entry.ticker, error: error.message }); return null; }
  });
  const events = fetched.filter(Boolean);
  const pairs = watch.flatMap(entry => {
    const event = events.find(e => e.event_ticker === entry.ticker);
    if (!event) return [];
    return entry.pairs.flatMap(pair => {
      const market = event.markets.find(m => m.ticker === pair.kalshiTicker);
      // A removed market must not fall back to a separate Kalshi fetch or a stale full-scan price.
      return market ? [{ ...pair, event, kalshiMarket: market, polymarketMarket: undefined }] : [];
    });
  });
  const options = { ...config, now, events, series, lookup };
  const cross = await scanCrossVenue(pairs, options);
  const candidates = [...noBaskets(events, options), ...ladders(events, options), ...cross.found].filter(c => !c.checks.includes('horizon'));
  return { scannedAt: now, events: events.length, candidates, hits: candidates.filter(c => isHit(c, config)),
    scope: events.map(e => e.event_ticker), errors: [...errors, ...cross.errors] };
}

export async function runGameday({ config, pairs = [], until, state = null, onRound = async () => {},
  runDryRun = async () => {}, onDryRunError = async () => {}, fullScan = runScan, fastScan = fastRound, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { fullMinutes = 5, fastSeconds = 15, watchSize = 20 } = config.gameday ?? {};
  if (![fullMinutes, fastSeconds].every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(watchSize) || watchSize < 0 || !Number.isFinite(until)) throw new Error('Invalid game-day schedule');
  let nextFull = -Infinity, nextFast = -Infinity, watch = [], series = {}, dryrun;
  while (now() < until) {
    const due = Math.min(nextFull, nextFast);
    if (now() < due) { await sleep(Math.min(due, until) - now()); continue; }
    const started = now(), tier = started >= nextFull ? 'full' : 'fast';
    const round = { tier, at: new Date(started).toISOString(), events: 0, candidates: 0, hits: 0, bestProfitPerContract: null, errors: [] };
    let closed = [];
    try {
      const scan = tier === 'full' ? await fullScan(config, pairs, started, { retainContext: true }) : await fastScan(config, watch, series, started);
      if (tier === 'full') {
        // shortcut: series settings and pair membership refresh only on full scans, refresh sooner when intraday metadata changes matter.
        series = scan.context.series;
        watch = selectWatchList(scan.candidates, scan.context, watchSize);
      }
      const tracked = track(state, scan.hits, scan.scannedAt, tier === 'fast' ? scan.scope : undefined);
      state = { ...tracked.state, scannedAt: scan.scannedAt };
      closed = tracked.closed;
      const edges = scan.candidates.map(c => c.profit / c.contracts).filter(Number.isFinite);
      Object.assign(round, { events: scan.events, candidates: scan.candidates.length, hits: scan.hits.length,
        bestProfitPerContract: edges.length ? edges.reduce((best, edge) => Math.max(best, edge), -Infinity) : null, errors: scan.errors ?? [] });
      const newHits = Object.values(state.open).filter(h => h.scans === 1 && h.lastSeen === scan.scannedAt);
      if (newHits.length) {
        if (dryrun) round.dryrunSkipped = true;
        else {
          // shortcut: new hits during an active replay are skipped, queue batches when replay coverage is required.
          dryrun = Promise.resolve().then(() => runDryRun({ open: Object.fromEntries(newHits.map(h => [h.id, h])) }))
            .catch(error => onDryRunError({ at: new Date(now()).toISOString(), roundAt: round.at, error: error.message }))
            .finally(() => { dryrun = null; });
        }
      }
    } catch (error) { round.errors.push({ error: error.message }); }
    if (tier === 'full') {
      nextFull = started + fullMinutes * 60000;
      round.watchList = watch.map(e => e.ticker);
    }
    nextFast = started + fastSeconds * 1000;
    round.durationMs = now() - started;
    await onRound(round, state, closed);
  }
  if (dryrun) await dryrun;
  return state;
}
