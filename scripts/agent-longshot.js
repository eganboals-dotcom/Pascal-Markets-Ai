// Agent C (plan Phase 1F), the favorite-longshot fade, walked forward over the downloaded history. Research only; no orders.
// Each settled market with books is read once, an hour before quoting would stop under the mm pull rules (before play starts for
// game markets). Day d is traded by bucket rules learned from days at least two before it: a day's markets trade up to 48 hours
// before their close day, so the day just before overlaps it. One contract per market at the posted price, taker fee, held to
// settlement. Closing-line value: the entry against the mid at the pull time. The newest 10 days stay locked unless --final.
import { historyDays, jsonLines, quoteEnd, settlementValue } from '../src/history.js';
import { bucketLabel, bucketOf, calibration, longshotRules } from '../src/agents/longshot.js';
import { GATE_RANGE, MAX_BOOK_AGE_MS, settle, sideTrade, summarize } from '../src/takers.js';
import { bootstrapTotal, sumByEvent } from '../src/stats.js';
import { markdownTable, readResearch } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const final = process.argv.includes('--final');
const margin = Number(process.argv.find(a => a.startsWith('--margin='))?.split('=')[1] ?? 0.01);
const config = readResearch('config/scan.json', {}), mm = config.mm ?? {}, feeRate = config.feeRate ?? 0.07;
const LEAD_MS = 3600000;
const mid = r => (r.yesBid + r.yesAsk) / 2;

async function loadDay(dir) {
  const outcome = new Map();
  for await (const m of jsonLines(`${dir}/markets.jsonl`)) {
    const value = settlementValue(m);
    if (m.books > 0 && value !== null) outcome.set(m.ticker, { settle: value, series: m.series });
  }
  const entry = new Map(), exit = new Map(), newer = (map, r) => !(map.get(r.ticker)?.time >= r.time);
  for await (const r of jsonLines(`${dir}/books.jsonl`)) {
    if (!outcome.has(r.ticker)) continue;
    const end = quoteEnd(r, mm);
    if (r.time <= end - LEAD_MS && newer(entry, r)) entry.set(r.ticker, r);
    if (r.time <= end && newer(exit, r)) exit.set(r.ticker, r);
  }
  return [...entry].filter(([, r]) => quoteEnd(r, mm) - LEAD_MS - r.time <= MAX_BOOK_AGE_MS).map(([ticker, r]) => ({
    ticker, ...outcome.get(ticker), mid: mid(r), bucket: bucketOf(mid(r)),
    book: { yesBid: r.yesBid, yesAsk: r.yesAsk, fee_multiplier: r.fee_multiplier ?? 1 }, exitMid: exit.has(ticker) ? mid(exit.get(ticker)) : null }));
}

const { days, locked, minDaysToLock } = historyDays(root, final);
const seen = [], trades = [], daily = [];
for (const [index, day] of days.entries()) {
  const samples = (await loadDay(`${root}/${day}`)).map(s => ({ ...s, index }));
  if (index >= 2) {
    const rules = longshotRules(seen.filter(s => s.index <= index - 2), { margin, feeRate });
    const today = samples.flatMap(s => {
      const rule = rules.get(s.bucket);
      if (!rule) return [];
      const t = sideTrade(rule.side, s.book, feeRate), exit = s.exitMid === null ? null : rule.side === 'yes' ? s.exitMid : 1 - s.exitMid;
      return [{ day, ticker: s.ticker, series: s.series, group: `${bucketLabel(s.bucket)} buy ${rule.side}`, side: rule.side, price: t.price,
        pnl: settle(t, s.settle), clv: exit === null ? null : exit - t.price - t.fee }];
    });
    trades.push(...today);
    daily.push({ day, locked: locked.includes(day), markets: samples.length, rules: [...rules].map(([b, r]) => `${bucketLabel(b)} ${r.side}`),
      trades: today.length, pnl: today.reduce((a, t) => a + t.pnl, 0) });
    console.log(JSON.stringify(daily.at(-1)));
  }
  seen.push(...samples);
}

const summary = summarize(trades);
summary.clv = bootstrapTotal(sumByEvent(trades.filter(t => t.clv !== null), t => t.clv).values(), GATE_RANGE);
summary.gateC = summary.passes && summary.clv.low > 0;
const table = calibration(seen);
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => x === null ? '' : `${(x * 100).toFixed(1)}¢`;
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`;
writeProjectFile(`${root}/agents/longshot-report.json`, JSON.stringify({ generatedAt: Date.now(), margin, summary, calibration: table, days: daily, trades }, null, 2) + '\n');
writeProjectFile(`${root}/agents/longshot-report.md`, ['# Agent C: favorite-longshot fade, walk-forward', '',
  'Research only. Each settled market is read an hour before quoting would stop (before play for games). A day is traded by price-bucket rules learned from days at least two before it: the better side of a bucket is bought only where at least 30 earlier events back it and its mean settled return beats the margin. One contract at the posted price, taker fee, held to settlement.', '',
  `Ranges are 97.5%, resampling whole events. Margin ${cents(margin)}. ${locked.length ? (final ? `The locked final exam (${locked[0]} to ${locked.at(-1)}) is included.` : `Locked final exam, not run: ${locked[0]} to ${locked.at(-1)}.`) : `No locked exam yet: fewer than ${minDaysToLock} days downloaded.`}`, '',
  '## Calibration (all days read)', '',
  markdownTable(['Price bucket', 'Markets', 'Events', 'Average price', 'Yes won'], table.map(r => [r.bucket, r.markets, r.events, cents(r.meanMid), cents(r.yesRate)])), '',
  '## Walk-forward trades', '',
  trades.length ? markdownTable(['', 'Trades', 'Settled P&L', 'Closing-line value', 'Per trade', 'Worst event'],
    [['All', summary.trades, range(summary.settled), range(summary.clv), cents(summary.perTrade), money(summary.worstEvent)]]) : 'No trades: no bucket had enough earlier events with a return above the margin.', '',
  trades.length ? markdownTable(['Rule', 'Trades', 'Settled P&L'], Object.entries(summary.groups).map(([g, v]) => [g, v.trades, money(v.pnl)])) : '', '',
  `Gate C (settled P&L and closing-line value above zero across their 97.5% ranges): ${summary.gateC ? 'passes' : 'fails'}.`, ''].join('\n'));
console.log(JSON.stringify({ trades: summary.trades, settled: summary.settled, clv: summary.clv, gateC: summary.gateC }));
