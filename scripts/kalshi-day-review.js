// Daily research audit; public recordings only, no account access or orders.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { projectPath, writeProjectFile } from '../src/files.js';
import { simulate } from '../src/mm.js';
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = t => { const n = typeof t === 'string' ? Date.parse(t) : t; return Number.isFinite(n) ? calendar.format(new Date(n)) : null; };
const selected = process.argv[2] ?? calendar.format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || !Number.isFinite(Date.parse(selected))) throw Error('Use YYYY-MM-DD');
const sources = [];
for (const directory of ['data/dashboard', 'data/gameday', 'research/kalshi']) {
  const entry = { directory, rounds: 0, tiers: {}, hitRounds: 0, errors: 0, checks: {}, rejectionObservations: {}, near: [] };
  const candidates = new Map();
  for (const filename of ['rounds.jsonl', 'dryrun.jsonl']) {
    const path = projectPath(`${directory}/${filename}`);
    if (!existsSync(path)) continue;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (day(r.at ?? r.checkedAt ?? r.startedAt) !== selected) continue;
      if (filename === 'dryrun.jsonl') { const outcome = String(r.outcome ?? 'unknown'); entry.checks[outcome] = (entry.checks[outcome] ?? 0) + 1; continue; }
      entry.rounds++; entry.tiers[r.tier] = (entry.tiers[r.tier] ?? 0) + 1;
      entry.hitRounds += Number(r.hits > 0); entry.errors += Array.isArray(r.errors) ? r.errors.length : Number(r.errors) || 0;
      for (const c of r.near ?? []) {
        for (const check of c.checks ?? []) entry.rejectionObservations[check] = (entry.rejectionObservations[check] ?? 0) + 1;
        if (c.verified !== true || !c.id || !(c.contracts > 0) || !Number.isFinite(c.profit)) continue;
        if (!candidates.has(c.id) || c.profit / c.contracts > candidates.get(c.id).profit / candidates.get(c.id).contracts)
          candidates.set(c.id, { id: c.id, title: c.title, kind: c.kind, contracts: c.contracts, profit: c.profit, returnPct: c.returnPct });
      }
    }
  }
  entry.near = [...candidates.values()].sort((a,b) => b.profit / b.contracts - a.profit / a.contracts).slice(0,5);
  sources.push(entry);
}
const books = [];
const path = projectPath('research/kalshi/books.jsonl');
if (existsSync(path)) for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
  try { const r = JSON.parse(line); if (day(r.time) === selected) books.push(r); } catch {}
}
const config = JSON.parse(readFileSync(projectPath('config/scan.json'),'utf8'));
const mm = simulate(books, { ...config.mm, makerFeeRate: config.makerFeeRate, takerFeeRate: config.feeRate ?? 0.07 });
const result = { date: selected, timezone: 'America/Los_Angeles', sources, model: { books: books.length, ...mm.total },
  limitations: ['No order ledger is connected; price-availability checks are not executions or realized returns.',
    'Legacy cross-venue checks do not establish settlement compatibility and are excluded from profit claims.',
    'Expired quote intervals are unobserved; zero inferred fills does not demonstrate a profitable or loss-free strategy.',
    'Near misses are only the logged shortlist; rejection counts include repeat observations.',
    'Daily model replay starts flat at the first recorded snapshot; dashboard daily P&L uses history with opening marks.'] };
const out = `research/daily/${selected}`;
writeProjectFile(`${out}.json`,JSON.stringify(result,null,2)+'\n');
const text = ['# Daily strategy review', '', `${selected} · America/Los_Angeles. Research and simulation only.`, '',
  ...sources.map(s => `- ${s.directory}: ${s.rounds} scan rounds; ${s.hitRounds} rounds with qualifying hits; ${s.errors} errors; price checks ${JSON.stringify(s.checks)}.`), '',
  '## Strategy changes', '',
  '- Expire unfilled model quotes after 30 seconds; distant snapshots cannot imply a resting fill.',
  '- Require at least half a cent of modeled maker edge after fees and before adverse selection.',
  '- Accept 15-minute markouts only within 30 seconds of the target horizon.',
  '- Evaluate up to eight depth breakpoints for liquid subsets of mutually exclusive No baskets. Subsets retain the at-most-one-winner payout bound.',
  '- Rank the fast watch list by taker basket edges; a conditional maker saving cannot displace a directly checkable event.', '',
  '## Updated model replay', '',
  `Public book observations: ${books.length}. Inferred fills: ${mm.total.fills}. Expired quote intervals: ${mm.total.staleIntervals}. Net marked model P&L: $${mm.total.netPnl.toFixed(4)}.`, '',
  '## Strongest logged verified near misses', '',
  ...sources.flatMap(s => s.near.slice(0,3).map(c => `- ${s.directory}: ${c.title} (${c.kind}), ${(c.profit/c.contracts*100).toFixed(3)} cents per basket contract, $${c.profit.toFixed(4)} modeled total, ${(c.returnPct*100).toFixed(3)}% return.`)), '',
  '## Limits', '', ...result.limitations.map(s=>`- ${s}`), '',
  'Fees and complementary book prices were checked against [Kalshi fees](https://kalshi.com/docs/kalshi-fee-schedule.pdf) and [orderbook documentation](https://docs.kalshi.com/getting_started/orderbook_responses).', ''].join('\n');
writeProjectFile(`${out}.md`,text);
console.log(JSON.stringify({date:selected,sources:sources.map(({directory,rounds,hitRounds,checks})=>({directory,rounds,hitRounds,checks})),model:result.model}));
