// Market-data research scheduling; REST rounds are serial, feed scans run in the background.
import { fetchEvent } from './kalshi.js';
import { publicLookup } from './polymarket.js';
import { mapConcurrent } from './dryrun.js';
import { isHit, ladders, noBaskets, runScan, scanCrossVenue, track } from './scan.js';
import { createFeed } from './feed.js';
import { backgroundScan } from './scan-worker.js';

export function selectWatchList(candidates, { events = [], pairs = [] } = {}, size = 20) {
  if (!Number.isInteger(size) || size < 0) throw new Error('Invalid watch size');
  const best = new Map();
  for (const c of candidates) {
    if (!c.event || !Array.isArray(c.checks) || c.checks.length > 0) continue;
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
    scope: watch.map(e => e.ticker), errors: [...errors, ...cross.errors] };
}

export async function runGameday({ config, pairs = [], until, state = null, onRound = async () => {}, feedMode, feedFactory,
  runDryRun = async () => {}, onDryRunError = async () => {}, fullScan = runScan, fastScan = fastRound, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (feedMode) return runFeedGameday({ config, pairs, until, state, onRound, runDryRun, onDryRunError,
    fullScan, now, sleep, feedMode, feedFactory });
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
        bestProfitPerContract: edges.length ? edges.reduce((best, edge) => Math.max(best, edge), -Infinity) : null, errors: scan.errors ?? [],
        near: scan.candidates.filter(c => !isHit(c, config)).sort((a, b) => b.returnPct - a.returnPct).slice(0, 25) });
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
    } catch (error) {
      round.errors.push({ error: error.message });
      const tracked = track(state, [], now(), tier === 'fast' ? watch.map(e => e.ticker) : undefined);
      state = { ...tracked.state, scannedAt: now() };
      closed = tracked.closed.map(h => ({ ...h, closedReason: 'market data unavailable' }));
    }
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

export function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

export function feedWatchSize(size, maximum, p95, limit, fullScan = false) {
  if (p95 == null) return size;
  if (!fullScan && p95 > limit) return size ? Math.max(1, Math.floor(size * 0.8)) : 0;
  if (fullScan && p95 < limit / 2) return Math.min(maximum, Math.max(size + 1, Math.ceil(size * 1.1)));
  return size;
}

// The full scan owns all events except those currently maintained by the feed.
export function trackFullScan(state, scan, watched) {
  const owned = new Set(watched);
  const scope = new Set([...Object.values(state?.open ?? {}).map(h => h.event),
    ...scan.hits.map(h => h.event)].filter(t => !owned.has(t)));
  return track(state, scan.hits, scan.scannedAt, scope);
}

export function coalesceEvents(priceEvent, { schedule = setImmediate, cancel = clearImmediate } = {}) {
  const pending = new Map();
  let handle;
  return {
    add(ticker, receivedAt) {
      pending.set(ticker, Math.min(pending.get(ticker) ?? Infinity, receivedAt));
      if (handle != null) return;
      handle = schedule(() => {
        handle = undefined;
        const batch = [...pending]; pending.clear();
        for (const [event, receipt] of batch) priceEvent(event, receipt);
      });
    },
    stop() { if (handle != null) cancel(handle); pending.clear(); handle = undefined; }
  };
}

export async function runFeedGameday({ config, pairs = [], until, state = null, onRound = async () => {},
  runDryRun = async () => {}, onDryRunError = async () => {}, fullScan = runScan,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  feedMode = 'production', feedFactory = createFeed, lookup = publicLookup(), coalesceOptions } = {}) {
  const { fullMinutes = 5, fastSeconds = 15, feedWatchSize: maximum = 300, maxLatencyMs = 100 } = config.gameday ?? {};
  if (![fullMinutes, fastSeconds, maxLatencyMs].every(n => Number.isFinite(n) && n > 0) ||
      !Number.isInteger(maximum) || maximum < 0 || !Number.isFinite(until)) throw new Error('Invalid feed schedule');
  let watch = [], context = { events: [], series: {}, pairs: [] }, capacity = maximum;
  let full, fast, dryrun, output = Promise.resolve(), running = true, latestP95 = null;
  let samples = [], nextFull = -Infinity, nextFast = Infinity, nextLatency = now() + 60000;
  const marketEvents = new Map(), eventsByTicker = new Map();
  const scanAbort = new AbortController();
  const scanFull = fullScan === runScan ? (...args) => backgroundScan(...args, scanAbort.signal) : fullScan;
  const log = (round, closed = []) => {
    const snapshot = state;
    output = output.then(() => onRound({ mode: feedMode, ...round }, snapshot, closed));
  };
  const replay = (round, at) => {
    const hits = Object.values(state?.open ?? {}).filter(h => h.scans === 1 && h.lastSeen === at);
    if (!hits.length) return;
    if (dryrun) { round.dryrunSkipped = true; return; }
    // shortcut: new hits during an active replay are skipped, queue batches when replay coverage is required.
    dryrun = Promise.resolve().then(() => runDryRun({ open: Object.fromEntries(hits.map(h => [h.id, h])) }))
      .catch(error => onDryRunError({ at: new Date(now()).toISOString(), error: error.message }))
      .finally(() => { dryrun = null; });
  };
  function accept(scan, tier, started, tracked) {
    state = { ...tracked.state, scannedAt: scan.scannedAt };
    const edges = scan.candidates.map(c => c.profit / c.contracts).filter(Number.isFinite);
    const round = { tier, at: new Date(started).toISOString(), durationMs: now() - started,
      events: scan.events, candidates: scan.candidates.length, hits: scan.hits.length,
      bestProfitPerContract: edges.length ? edges.reduce((a, b) => Math.max(a, b), -Infinity) : null, errors: scan.errors ?? [] };
    if (tier !== 'feed') round.near = scan.candidates.filter(c => !isHit(c, config))
      .sort((a, b) => b.returnPct - a.returnPct).slice(0, 25);
    replay(round, scan.scannedAt);
    if (tier === 'full') round.watchList = watch.map(e => e.ticker);
    log(round, tracked.closed);
  }
  function swapWatch(next) {
    const removed = watch.filter(entry => !next.some(n => n.ticker === entry.ticker));
    watch = next; marketEvents.clear(); eventsByTicker.clear();
    for (const entry of watch) {
      const event = context.events.find(e => e.event_ticker === entry.ticker);
      if (!event) continue;
      eventsByTicker.set(entry.ticker, event);
      for (const m of event.markets ?? []) marketEvents.set(m.ticker, entry.ticker);
    }
    feed.setMarkets([...marketEvents.keys()]);
    for (const entry of [...watch, ...removed]) coalescer.add(entry.ticker, now());
  }
  function liveEvent(ticker) {
    // shortcut: metadata refreshes on full scans, add lifecycle messages before relying on intraday status changes.
    const event = eventsByTicker.get(ticker);
    const markets = event?.markets.filter(m => m.status === 'active');
    if (!markets?.length) return null;
    const current = markets.map(m => {
      const top = feed.top(m.ticker);
      return top ? { ...m, ...top } : null;
    });
    if (current.some(m => m === null)) return null;
    return { ...event, markets: current };
  }
  const coalescer = coalesceEvents((ticker, receivedAt) => {
    if (!running) return;
    const event = liveEvent(ticker);
    if (!event) {
      const tracked = track(state, [], now(), [ticker]);
      if (tracked.closed.length) {
        tracked.closed = tracked.closed.map(h => ({ ...h, closedReason: 'market data unavailable' }));
        accept({ scannedAt: now(), events: 0, candidates: [], hits: [] }, 'feed-stale', now(), tracked);
      }
      return;
    }
    const started = now(), options = { ...config, now: started, series: context.series };
    const candidates = [...noBaskets([event], options), ...ladders([event], options)].filter(c => !c.checks.includes('horizon'));
    const hits = candidates.filter(c => isHit(c, config));
    const preserved = Object.values(state?.open ?? {}).filter(h => h.event === ticker && h.kind === 'cross-venue');
    const tracked = track(state, [...hits, ...preserved], started, [ticker]);
    // Preserve the cross-venue polling clock and scan count.
    for (const h of preserved) tracked.state.open[h.id] = h;
    samples.push(now() - receivedAt);
    accept({ scannedAt: started, events: 1, candidates, hits }, 'feed', started, tracked);
  }, coalesceOptions);
  const feed = feedFactory({ mode: feedMode, now,
    onTop: (ticker, receivedAt) => { const event = marketEvents.get(ticker); if (event) coalescer.add(event, receivedAt); },
    onError: error => log({ tier: 'feed-error', at: new Date(now()).toISOString(), errors: [{ error: error.message }] }) });
  feed.start();
  try {
    while (now() < until) {
      const at = now();
      if (at >= nextFull && !full) {
        nextFull = at + fullMinutes * 60000;
        full = Promise.resolve().then(() => scanFull(config, pairs, at, { retainContext: true, demo: feedMode === 'demo' }))
          .then(scan => {
            if (!running) return;
            context = scan.context;
            capacity = feedWatchSize(capacity, maximum, latestP95, maxLatencyMs, true);
            const next = selectWatchList(scan.candidates, context, capacity);
            const tracked = trackFullScan(state, scan, [...watch, ...next].map(e => e.ticker));
            swapWatch(next);
            nextFast = Math.min(nextFast, now());
            accept(scan, 'full', at, tracked);
          }).catch(error => {
            if (!running) return;
            const tracked = trackFullScan(state, { hits: [], scannedAt: now() }, watch.map(e => e.ticker));
            state = { ...tracked.state, scannedAt: now() };
            log({ tier: 'full', at: new Date(at).toISOString(), errors: [{ error: error.message }] },
              tracked.closed.map(h => ({ ...h, closedReason: 'market data unavailable' })));
          })
          .finally(() => { full = null; });
      }
      if (at >= nextFast && !fast) {
        nextFast = at + fastSeconds * 1000;
        const selected = watch.map(entry => ({ entry, event: liveEvent(entry.ticker) })).filter(x => x.event && x.entry.pairs.length);
        const generation = context;
        const pairList = selected.flatMap(({ entry, event }) => entry.pairs.flatMap(pair => {
          const market = event.markets.find(m => m.ticker === pair.kalshiTicker);
          return market ? [{ ...pair, event, kalshiMarket: market, polymarketMarket: undefined }] : [];
        }));
        if (pairList.length) fast = scanCrossVenue(pairList, { ...config, now: at, series: context.series, lookup,
          currentTime: now, currentKalshiMarket: pair => liveEvent(pair.event.event_ticker)?.markets.find(m => m.ticker === pair.kalshiTicker) })
          .then(cross => {
            if (!running || context !== generation) return;
            const scope = selected.filter(x => watch.some(w => w.ticker === x.entry.ticker)).map(x => x.entry.ticker);
            const candidates = cross.found.filter(c => scope.includes(c.event) && liveEvent(c.event) && !c.checks.includes('horizon'));
            const hits = candidates.filter(c => isHit(c, config));
            const preserved = Object.values(state?.open ?? {}).filter(h => scope.includes(h.event) && h.kind !== 'cross-venue');
            const tracked = track(state, [...hits, ...preserved], at, scope);
            for (const h of preserved) tracked.state.open[h.id] = h;
            accept({ scannedAt: at, events: scope.length, candidates, hits, errors: cross.errors }, 'fast', at, tracked);
          }).catch(error => log({ tier: 'fast', at: new Date(at).toISOString(), errors: [{ error: error.message }] }))
          .finally(() => { fast = null; });
      }
      if (at >= nextLatency) {
        const latency = latencySummary(samples); samples = []; latestP95 = latency.p95;
        const previous = capacity;
        capacity = feedWatchSize(capacity, maximum, latestP95, maxLatencyMs);
        if (capacity < previous) swapWatch(watch.slice(0, capacity));
        log({ tier: 'latency', at: new Date(at).toISOString(), ...latency, watchSize: watch.length,
          ...(capacity < previous ? { shrunkFrom: previous, capacity } : {}), messages: { ...feed.counts } });
        nextLatency = at + 60000;
      }
      await sleep(Math.min(100, Math.max(0, until - now())));
    }
  } finally {
    running = false; coalescer.stop(); feed.stop(); scanAbort.abort();
    await Promise.allSettled([full, fast, dryrun]);
    log({ tier: 'latency', final: true, at: new Date(now()).toISOString(), ...latencySummary(samples),
      watchSize: watch.length, messages: { ...feed.counts } });
    await output;
  }
  return state;
}
