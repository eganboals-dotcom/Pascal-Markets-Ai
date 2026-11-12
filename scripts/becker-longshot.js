// Agent C's favorite-longshot fade walked forward over four years of the Becker dataset (2021-07 to 2025-11), which ends before
// the project's own Kalshi history begins. Samples come from scripts/becker-longshot-samples.py: node scripts/becker-longshot.js
// [hours, default 2]. As in scripts/agent-longshot.js, a day is traded by bucket rules learned from markets that closed at least
// two days earlier, one contract at the ask the trades show, today's taker fee, held to settlement. Research only; no orders.
import { jsonLines } from '../src/history.js';
import { bucketLabel, bucketOf, calibration, ruleTracker } from '../src/agents/longshot.js';
import { GATE_RANGE, settle, sideTrade, summarize } from '../src/takers.js';
import { bootstrapTotal, sumByEvent } from '../src/stats.js';
import { markdownTable } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';

const hours = process.argv[2] ?? '2', root = 'data/becker', DAY_MS = 86400000, feeRate = 0.07;
const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

const samples = [];
for await (const r of jsonLines(`${root}/longshot-samples-${hours}h.jsonl`)) {
  const mid = (r.yesBid + r.yesAsk) / 2;
  samples.push({ ...r, mid, bucket: bucketOf(mid), dayNumber: dayNumber(r.day), book: { yesBid: r.yesBid, yesAsk: r.yesAsk, fee_multiplier: 1 } });
}
samples.sort((a, b) => a.dayNumber - b.dayNumber);
if (!samples.length) throw new Error(`No samples: run .venv/Scripts/python -I scripts/becker-longshot-samples.py ${hours}`);

const tracker = ruleTracker({ feeRate }), trades = [];
let learned = 0;
for (let i = 0; i < samples.length;) {
  const today = samples[i].dayNumber;
  while (learned < samples.length && samples[learned].dayNumber <= today - 2) tracker.add(samples[learned++]);
  const rules = tracker.rules();
  for (; i < samples.length && samples[i].dayNumber === today; i++) {
    const s = samples[i], rule = rules.get(s.bucket);
    if (!rule) continue;
    const t = sideTrade(rule.side, s.book, feeRate), exit = s.exitMid === null ? null : rule.side === 'yes' ? s.exitMid : 1 - s.exitMid;
    trades.push({ day: s.day, ticker: s.ticker, group: `${bucketLabel(s.bucket)} buy ${rule.side}`, side: rule.side, price: t.price,
      pnl: settle(t, s.settle), clv: exit === null ? null : exit - t.price - t.fee });
  }
}

const score = list => {
  const s = summarize(list);
  s.clv = bootstrapTotal(sumByEvent(list.filter(t => t.clv !== null), t => t.clv).values(), GATE_RANGE);
  s.gateC = s.passes && s.clv.low > 0;
  return s;
};
const summary = score(trades), years = [...new Set(trades.map(t => t.day.slice(0, 4)))].map(year => [year, score(trades.filter(t => t.day.startsWith(year)))]);
const table = calibration(samples), final = ruleTracker({ feeRate });
samples.forEach(s => final.add(s));
const next = [...final.rules()].map(([bucket, r]) => ({ bucket, label: bucketLabel(bucket), side: r.side, mean: r.mean, events: r.events }));
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), cents = x => x === null ? '' : `${(x * 100).toFixed(1)}¢`;
const range = r => `${money(r.total)} (${money(r.low)} to ${money(r.high)})`;
const row = (label, s) => [label, s.trades, range(s.settled), range(s.clv), cents(s.perTrade), money(s.worstEvent), s.gateC ? 'passes' : 'fails'];

writeProjectFile(`${root}/longshot-report-${hours}h.json`, JSON.stringify({ generatedAt: Date.now(), hours: Number(hours), summary,
  years: Object.fromEntries(years), calibration: table, next, trades }, null, 2) + '\n');
writeProjectFile(`${root}/longshot-report-${hours}h.md`, [`# Agent C on the Becker dataset, read ${hours} hours before close`, '',
  `Research only. ${samples.length} settled markets (${samples[0].day} to ${samples.at(-1).day}, none after 2025-11-24) with at least 1,000 contracts traded and a trade on each side in the hour before the read. The ask and bid are the last trades a buyer and a seller took. A day is traded by price-bucket rules learned from markets that closed at least two days earlier, where 30 events back the bucket and its mean return beats 1¢. Today's taker fee (7% of p(1−p)) is charged in every year. Closing-line value is against the midpoint of the last buy and sell in the two hours up to an hour after the read. Ranges are 97.5%, resampling whole events.`, '',
  '## Calibration (all markets read)', '',
  markdownTable(['Price bucket', 'Markets', 'Events', 'Average price', 'Yes won'], table.map(r => [r.bucket, r.markets, r.events, cents(r.meanMid), cents(r.yesRate)])), '',
  '## Walk-forward trades', '',
  markdownTable(['', 'Trades', 'Settled P&L', 'Closing-line value', 'Per trade', 'Worst event', 'Gate C'], [row('All', summary), ...years.map(([y, s]) => row(y, s))]), '',
  markdownTable(['Rule', 'Trades', 'Settled P&L'], Object.entries(summary.groups).map(([g, v]) => [g, v.trades, money(v.pnl)])), '',
  `Rules from all four years: ${next.map(r => `${r.label} buy ${r.side} (${cents(r.mean)} a contract over ${r.events} events)`).join('; ') || 'none'}.`, ''].join('\n'));
console.log(JSON.stringify({ hours, samples: samples.length, trades: summary.trades, settled: summary.settled, clv: summary.clv, gateC: summary.gateC,
  years: years.map(([y, s]) => [y, s.trades, Math.round(s.settled.total), Math.round(s.clv.total)]), next: next.map(r => `${r.label} ${r.side}`) }));
