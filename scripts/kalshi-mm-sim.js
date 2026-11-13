import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { simulate, sizedFill } from '../src/mm.js';
import { fetchMarkets } from '../src/kalshi.js';
import { readResearch, markdownTable } from '../src/report.js';
import { projectPath, recordingFiles, writeProjectFile } from '../src/files.js';
import { HEARTBEAT_MS } from '../src/history.js';
import { policy } from '../src/bandit.js';
import { beat } from '../src/heartbeat.js';

const out = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'research/kalshi';
const config = readResearch('config/scan.json', {});
// --history replays a backfilled day in full; its candle rows are a minute or more apart (see src/history.js), so quotes rest until the next change.
const history = process.argv.includes('--history');
const historyLimits = history ? { maxQuoteAgeMs: HEARTBEAT_MS + 60000, maxMarkoutDelayMs: HEARTBEAT_MS + 60000 } : {};
// Streamed line by line: a week of 100-market recordings is larger than Node can hold as one string.
// The game-day recorder may be appending while this replay reads; an unfinished final line is left for the next run.
// The live file and its daily roll-overs from the window's first day are read, oldest first.
async function readRecent(name, days = config.mm?.replayDays ?? 7) {
  const since = Date.now() - days * 86400000, rows = [];
  const keep = line => { const row = JSON.parse(line); if (row.time >= since) rows.push(row); };
  for (const path of recordingFiles(out, name, since)) {
    let pending = null;
    try {
      for await (const line of createInterface({ input: createReadStream(projectPath(path)), crlfDelay: Infinity })) {
        if (pending) keep(pending);
        pending = line || null;
      }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; } // rolled over after it was listed
    if (pending) { try { keep(pending); } catch { /* unfinished final line */ } }
  }
  return rows;
}
// Settled outcomes are permanent, so they are cached; only markets missing from recent books are asked about again.
async function readSettlements(books, now = Date.now()) {
  const path = `${out}/settlements.json`, known = readResearch(path, {});
  const lastSeen = new Map(books.map(b => [b.ticker, b.time]));
  const ask = [...lastSeen].filter(([t, time]) => !(t in known) && now - time > 5 * 60000).map(([t]) => t);
  try {
    for (const m of ask.length ? await fetchMarkets(ask) : []) if (m.result === 'yes' || m.result === 'no') known[m.ticker] = m.result === 'yes' ? 1 : 0;
    if (ask.length) writeProjectFile(path, JSON.stringify(known) + '\n');
  } catch (error) { console.error(JSON.stringify({ settlementError: error.message })); } // Unsettled marks still stand; the next run retries.
  return known;
}
const days = history ? Infinity : undefined;
const books = await readRecent('books', days), trades = await readRecent('trades', days);
const settlements = await readSettlements(books);
const options = { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175, takerFeeRate: config.feeRate ?? 0.07, ...historyLimits, settlements, trades };
const result = { generatedAt: Date.now(), ...simulate(books, options) };
// The learned policy (src/bandit.js, trained by kalshi-bandit.js on the downloaded history) on the same books: it declines the fixed
// rules' quotes in contexts whose closing-line value was negative. Its totals sit beside the fixed rules' in the report.
const MODEL = 'data/history/bandit-model.json';
const learnedRun = existsSync(projectPath(MODEL)) ? simulate(books, { ...options, allow: policy(JSON.parse(readFileSync(projectPath(MODEL), 'utf8')), config.mm ?? {}) }) : null;
result.learned = learnedRun?.total ?? null;
// Quote size (mm.quoteSize, 5: the largest size whose low end stays positive under both fill rules in kalshi-bandit.js): every one-contract fill re-scored at the size, held to settlement.
const quoteSize = config.mm?.quoteSize ?? 1;
const sizedTotal = markets => {
  const t = { contracts: 0, clv: 0, settledFills: 0, settledPnl: 0 };
  for (const m of markets) for (const f of m.fillLog) {
    const r = sizedFill(f, quoteSize, settlements[m.ticker]);
    t.contracts += r.contracts; t.clv += r.clv;
    if (r.settled !== null) { t.settledFills++; t.settledPnl += r.settled; }
  }
  return t;
};
result.sized = { size: quoteSize, fixed: sizedTotal(result.markets), learned: learnedRun ? sizedTotal(learnedRun.markets) : null };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), line = t => `${t.fills} fills, ${money(t.netPnl)} net, ${money(t.clv)} closing-line value`;
const sizedLine = t => `${t.contracts} contracts, ${money(t.settledPnl)} settled on ${t.settledFills} settled fills, ${money(t.clv)} closing-line value`;
try {
  // 'quoting', never 'waiting': the live agents read a fresh 'waiting' maker row as the model run waiting for the download (src/paper.js).
  beat('maker', 'quoting', `Paper quoting on ${result.markets.length} markets over ${history ? 'the replayed day' : `${config.mm?.replayDays ?? 7} days`}: fixed rules ${line(result.total)}`
    + (result.learned ? `; learned policy ${line(result.learned)}` : '') + `; at ${quoteSize} a quote, ${sizedLine(result.sized.learned ?? result.sized.fixed)}`, { nextWithinMs: 30 * 60000 });
} catch (error) { console.error(JSON.stringify({ heartbeat: error.message })); }
const rows = [...result.markets, { ticker: 'TOTAL', ...result.total }];
writeProjectFile(`${out}/mm-sim.md`, ['# Market-making simulation', '', 'Research only. One-contract quotes, replaced at each snapshot, re-scored at the quote size below. Quotes stop before a game starts, after a mid jump, and outside the mid-price band.', '',
  `Settled markets: ${result.markets.filter(m => m.settled).length} of ${result.markets.length}, valued at their $1/$0 outcome. Recorded trades: ${trades.length}; fills from trades: ${result.total.tradeFills}.`, '',
  result.learned ? `Learned policy on the same books: ${line(result.learned)}, against the fixed rules' ${line(result.total)}.` : 'No learned model found (data/history/bandit-model.json).', '',
  `At ${quoteSize} contracts a quote (each fill at the smaller of the size and the contracts traded through it, held to settlement, as if first in line: an upper bound): fixed rules ${sizedLine(result.sized.fixed)}`
    + (result.sized.learned ? `; learned policy ${sizedLine(result.sized.learned)}.` : '.'), '',
  `Quote lifetime: ${config.mm?.maxQuoteAgeMs ?? 30000} ms. Expired quote intervals: ${result.total.staleIntervals}. Sparse intervals cannot establish fills.`, '',
  'Net P&L is cash plus final inventory at its exit side (bid for a long, ask for a short) less the taker fee to flatten it, after fees. Spread captured measures quote improvement versus the posting mid. Signed adverse-selection loss measures fill price against the first observed mid at least 15 minutes later; negative values are favorable. This diagnostic is not subtracted from net P&L again. Unmarked fills lack a later observation. Realized P&L is closed inventory profit less all incurred fees. Unrealized P&L is the remaining inventory at that exit value against average entry cost. A settled market has no unrealized P&L: its inventory is valued at the outcome, without an exit fee. Liquidation depth is not simulated.', '',
  markdownTable(['Market', 'Fills', 'Spread captured', 'Fees', 'Adverse-selection loss', 'Unmarked fills', 'Realized P&L', 'Unrealized P&L', 'Net P&L'], rows.map(r => [r.ticker, r.fills, r.spreadCaptured.toFixed(4), r.fees.toFixed(4), r.adverseSelectionLoss.toFixed(4), r.unmarkedFills, r.realizedPnl.toFixed(4), r.unrealizedPnl.toFixed(4), r.netPnl.toFixed(4)])), ''].join('\n'));
writeProjectFile(`${out}/mm-sim.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
