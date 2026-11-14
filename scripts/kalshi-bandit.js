// Walk-forward test of the learned quoting policy on backfilled history: each day is first traded by a model trained only on
// days at least two before it, scored against the fixed rules on the same day, and learned from a day later. Research only; no orders.
// The newest 10 days are a locked final exam: skipped unless --final is passed, which should happen once, at the very end.
import { simulate, sizedFill } from '../src/mm.js';
import { addTrained, emptyModel, marketSamples, policy, train } from '../src/bandit.js';
import { HEARTBEAT_MS, historyDays, jsonLines, settlementValue } from '../src/history.js';
import { bootstrapTotal, eventOf, pairedDifference, sumByEvent } from '../src/stats.js';
import { readResearch, markdownTable } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';
import { profitToRisk } from '../src/tuner.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
// --strict: fills only on prints strictly through the quote (a lower bound), written to bandit-*-strict files beside the usual ones.
const strict = process.argv.includes('--strict'), out = name => `${root}/${name}${strict ? '-strict' : ''}`;
const config = readResearch('config/scan.json', {});
const mm = { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175, takerFeeRate: config.feeRate ?? 0.07, maxQuoteAgeMs: HEARTBEAT_MS + 60000, maxMarkoutDelayMs: HEARTBEAT_MS + 60000, strictFills: strict };

// Only finished, quotable markets: others cannot fill. A restarted backfill can repeat one market's rows, so rows dedupe by time and trades by id.
async function loadDay(dir) {
  const markets = [];
  for await (const m of jsonLines(`${dir}/markets.jsonl`)) if (m.quotable && settlementValue(m) !== null) markets.push(m);
  const settlements = Object.fromEntries(markets.map(m => [m.ticker, settlementValue(m)]));
  const books = new Map(markets.map(m => [m.ticker, new Map()])), tapes = new Map(markets.map(m => [m.ticker, new Map()]));
  for await (const r of jsonLines(`${dir}/books.jsonl`)) books.get(r.ticker)?.set(r.time, r);
  for await (const t of jsonLines(`${dir}/trades.jsonl`)) tapes.get(t.ticker)?.set(t.tradeId, t);
  const sorted = map => new Map([...map].map(([k, v]) => [k, [...v.values()].sort((a, b) => a.time - b.time)]));
  return { settlements, books: sorted(books), tapes: sorted(tapes) };
}

const { days, locked, minDaysToLock } = historyDays(root, final);
let model = emptyModel(), heldBack = null;
const daily = [], fixedMarkets = [], learnedMarkets = [], learnedFills = [];
for (const day of days) {
  const { settlements, books, tapes } = await loadDay(`${root}/${day}`);
  const snapshots = [...books.values()].flat(), trades = [...tapes.values()].flat();
  if (model.days.length) {
    const run = allow => simulate(snapshots, { ...mm, settlements, trades, allow }).markets;
    const fixed = run(null), learned = run(policy(model, mm));
    fixedMarkets.push(...fixed.map(m => ({ ...m, day }))); learnedMarkets.push(...learned.map(m => ({ ...m, day, outcome: settlements[m.ticker] })));
    for (const m of learned) for (const f of m.fillLog) learnedFills.push({ ...f, event: eventOf(m.ticker), outcome: settlements[m.ticker] });
    const sum = (list, key) => list.reduce((n, m) => n + m[key], 0);
    daily.push({ day, locked: locked.includes(day), markets: books.size, fixedFills: sum(fixed, 'fills'), fixedClv: sum(fixed, 'clv'), fixedNet: sum(fixed, 'netPnl'),
      learnedFills: sum(learned, 'fills'), learnedClv: sum(learned, 'clv'), learnedNet: sum(learned, 'netPnl') });
    console.log(JSON.stringify(daily.at(-1)));
  }
  const events = new Map();
  for (const [ticker, rows] of books) {
    const e = eventOf(ticker);
    if (!events.has(e)) events.set(e, []);
    events.get(e).push(...marketSamples(rows, tapes.get(ticker) ?? [], mm));
  }
  // A day's markets quote up to 48 hours before they close, so the next day's folder overlaps this one in time:
  // this day joins the model only after the next day has been tested. It is held as trained counts, not raw samples.
  if (heldBack) model = addTrained(model, heldBack);
  heldBack = train(emptyModel(), [...events.values()], day);
}
if (heldBack) model = addTrained(model, heldBack); // the saved model covers every day

const score = (list, key) => bootstrapTotal(sumByEvent(list, m => m[key]).values());
const diff = key => bootstrapTotal(pairedDifference(sumByEvent(fixedMarkets, m => m[key]), sumByEvent(learnedMarkets, m => m[key])));
const fills = list => list.reduce((n, m) => n + m.fills, 0);
// Capacity: contracts that traded at or through each filled quote, times that fill's closing-line value. An upper bound:
// it assumes the model's quote was first in line for all of them, which a real queue does not grant.
const capacity = list => list.flatMap(m => m.fillLog).reduce((n, f) => n + f.clv * f.available, 0);
const tested = daily.length || 1;
const summary = {
  testedDays: daily.length, lockedDays: locked, finalExamRun: final, contexts: Object.keys(model.keys).length,
  fixed: { fills: fills(fixedMarkets), settled: score(fixedMarkets, 'netPnl'), clv: score(fixedMarkets, 'clv'), capacityPerDay: capacity(fixedMarkets) / tested },
  learned: { fills: fills(learnedMarkets), settled: score(learnedMarkets, 'netPnl'), clv: score(learnedMarkets, 'clv'), capacityPerDay: capacity(learnedMarkets) / tested },
  learnedMinusFixed: { settled: diff('netPnl'), clv: diff('clv') }
};
// Quote size: each learned fill at min(size, contracts that traded through it), held to settlement, the fee charged on the whole
// order. Ranked like the picker, by the low end of the event-grouped range in dollars.
// shortcut: first in line for every traded contract and the inventory cap scaled with size, so this is an upper bound; depth
// recordings and the Phase 2 pilot's real fill rate make it real.
summary.sizing = [1, 2, 5, 10, 25, 50, 100].map(size => {
  const settled = [], clv = [];
  let contracts = 0;
  for (const f of learnedFills) {
    const r = sizedFill(f, size, f.outcome);
    contracts += r.contracts;
    if (r.settled !== null) settled.push({ event: f.event, pnl: r.settled, stake: r.stake });
    clv.push({ event: f.event, pnl: r.clv, stake: r.stake });
  }
  const s = profitToRisk(settled), c = profitToRisk(clv);
  return { size, contracts,
    settled: s.pnl, settledLow: s.low, worstEvent: s.worstEvent, clv: c.pnl, clvLow: c.low, staked: s.stake, perDay: s.pnl / tested };
});
// Gate 0 from the plan: closing-line value above zero with its whole range, and settled P&L not significantly negative.
const passes = s => s.clv.low > 0 && s.settled.high >= 0;
summary.gate0 = { fixed: passes(summary.fixed), learned: passes(summary.learned), learnedBetter: summary.learnedMinusFixed.clv.low > 0 && summary.learnedMinusFixed.settled.high >= 0 };

const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`;
writeProjectFile(`${out('bandit-model')}.json`, JSON.stringify(model) + '\n');
writeProjectFile(`${out('bandit-report')}.json`, JSON.stringify({ generatedAt: Date.now(), summary, days: daily,
  // The fixed rules quote for the department scoreboard until the learned policy passes Gate 0; markets without fills are left out.
  markets: fixedMarkets.filter(m => m.fills).map(m => ({ day: m.day, ticker: m.ticker, fills: m.fills, clv: m.clv, pnl: m.netPnl })),
  // The learned policy per market, which the paper loop quotes; `sized` is settled P&L at the configured quote size, for the check by department.
  learnedMarkets: learnedMarkets.filter(m => m.fills).map(m => ({ day: m.day, ticker: m.ticker, fills: m.fills, clv: m.clv, pnl: m.netPnl,
    sized: m.fillLog.reduce((n, f) => n + (sizedFill(f, mm.quoteSize ?? 1, m.outcome).settled ?? 0), 0),
    // Settled P&L and money staked at each size, for picking a size per department.
    sizes: Object.fromEntries([1, 2, 5, 10, 25].map(size => [size, m.fillLog.reduce((a, f) => {
      const r = sizedFill(f, size, m.outcome);
      return { pnl: a.pnl + (r.settled ?? 0), stake: a.stake + r.stake };
    }, { pnl: 0, stake: 0 })])) })) }) + '\n');
writeProjectFile(`${out('bandit-report')}.md`, ['# Quoting policy, walk-forward', '',
  'Research only. Each day is traded by a model trained only on days at least two before it (markets quote up to 48 hours before their close day, so the day just before overlaps it), then added to its training a day later. Fixed: the configured quoting rules. Learned: the same rules, minus quotes declined where at least 30 earlier events show a negative closing-line value. One contract per quote; candle books without depth.' + (strict ? ' Strict fills: a quote fills only on a print or a book strictly through its price, never at it, so a queue at its own price cannot flatter it (a lower bound).' : ''), '',
  'Closing-line value: each fill against the last mid before quoting stopped, after fees. Low noise, but it flatters in thin markets. Settled P&L: the $1/$0 outcome. The truth, but noisy. Ranges are 90%, resampling whole events (all markets of a game together).', '',
  locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included in this run.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`, '',
  daily.length ? markdownTable(['', 'Fills', 'Closing-line value', 'Settled P&L', 'Capacity per day'], [
    ['Fixed rules', summary.fixed.fills, range(summary.fixed.clv), range(summary.fixed.settled), money(summary.fixed.capacityPerDay)],
    ['Learned', summary.learned.fills, range(summary.learned.clv), range(summary.learned.settled), money(summary.learned.capacityPerDay)],
    ['Learned minus fixed', '', range(summary.learnedMinusFixed.clv), range(summary.learnedMinusFixed.settled), '']]) : 'At least three downloaded days are needed before any day can be tested.', '',
  daily.length ? `Gate 0 (closing-line value above zero across its range, settled P&L not significantly negative): fixed ${summary.gate0.fixed ? 'passes' : 'fails'}, learned ${summary.gate0.learned ? 'passes' : 'fails'}; learned better than fixed: ${summary.gate0.learnedBetter ? 'yes' : 'no'}.` : '', '',
  daily.length ? markdownTable(['Quote size (learned)', 'Contracts', 'Settled P&L', 'Low end', 'Worst event', 'Closing-line value', 'Per day'],
    summary.sizing.map(r => [r.size, r.contracts, money(r.settled), money(r.settledLow), money(r.worstEvent), money(r.clv), money(r.perDay)])) : '', '',
  'Quote size fills each learned fill at the smaller of the size and the contracts traded through it, as if first in line: an upper bound.', '',
  'Capacity is an upper bound: every contract traded at or through a filled quote, times that fill\'s closing-line value, as if the quote were first in line.', '',
  daily.length ? markdownTable(['Day', 'Markets', 'Fixed fills', 'Fixed CLV', 'Fixed settled', 'Learned fills', 'Learned CLV', 'Learned settled'],
    daily.map(r => [r.day + (r.locked ? ' (exam)' : ''), r.markets, r.fixedFills, money(r.fixedClv), money(r.fixedNet), r.learnedFills, money(r.learnedClv), money(r.learnedNet)])) : '', ''].join('\n'));
console.log(JSON.stringify(summary));
