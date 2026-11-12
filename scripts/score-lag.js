// Kalshi's repricing lag after its own live score decides a market (src/score-lag.js), from score-watch's score log. For every
// decided moment in data/scores/<day>.jsonl it reads the event's settled markets and their public trade prints from 5 minutes before
// to 15 minutes after, and reports by sport and moment kind: how often the winning side already traded at 97¢ or more before the
// log saw the result, the median seconds to a 99¢ print, and the contracts takers still bought on the winning side below 99¢ (with
// their edge after the fee) in the first 30 seconds, to 2 minutes and to 15 minutes. Markets not yet settled are left for a later
// run. Writes data/scores/lag-report.{json,md}. Usage: node scripts/score-lag.js [day ...]
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchEvent, fetchTrades } from '../src/kalshi.js';
import { decisionMoments, lagStats } from '../src/score-lag.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const days = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const files = days.length ? days.map(d => `${d}.jsonl`) : readdirSync(projectPath('data/scores')).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
const rows = files.flatMap(f => readFileSync(projectPath(`data/scores/${f}`), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
const moments = decisionMoments(rows), events = new Map(), results = [];
console.log(`${moments.length} decided moments in ${files.length} day(s) of score log`);

for (const m of moments) {
  if (!events.has(m.event)) {
    try { events.set(m.event, (await fetchEvent(m.event)).markets ?? []); } catch (error) { console.error(m.event, error.message); events.set(m.event, []); }
    await sleep(120);
  }
  const markets = events.get(m.event).filter(x => ['yes', 'no'].includes(x.result) && (!m.goals || (x.floor_strike < m.goals && x.floor_strike >= m.goals - 1)));
  for (const x of markets) {
    let trades;
    try { trades = await fetchTrades(x.ticker, m.time - 5 * 60000, undefined, 3, m.time + 15 * 60000); } catch (error) { console.error(x.ticker, error.message); continue; }
    await sleep(120);
    results.push({ ...m, ticker: x.ticker, result: x.result, ...lagStats(trades, m.time, x.result) });
  }
}

const sport = t => ({ tennis_tournament_singles: 'tennis', soccer_tournament_multi_leg: 'soccer', esports_match: 'esports', table_tennis_match: 'table tennis' })[t] ?? t;
const groupOf = r => `${sport(r.type)} ${r.label.startsWith('goal') ? 'goal' : r.label.replace(/ \d+$/, '')} ${r.type === 'esports_match' ? r.event.split('-')[0] : ''}`.trim();
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const groups = new Map();
for (const r of results) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
const table = [...groups].map(([group, rs]) => {
  const sum = (w, k) => rs.reduce((a, r) => a + r.cheap[w][k], 0);
  return { group, markets: rs.length, pricedBefore: rs.filter(r => r.before >= 0.97).length, noTradesAfter: rs.filter(r => !r.trades).length,
    medianSecondsTo99: median(rs.map(r => r.secondsTo99)), medianLastUnder97: median(rs.map(r => r.lastUnder97)),
    cheap: Object.fromEntries(['first30s', 'to2m', 'to15m'].map(w => [w, { contracts: Math.round(sum(w, 'contracts')), edge: Number(sum(w, 'edge').toFixed(2)) }])) };
}).sort((a, b) => b.cheap.first30s.edge + b.cheap.to2m.edge - a.cheap.first30s.edge - a.cheap.to2m.edge);

const md = ['# Kalshi repricing lag after the live score', '', `${results.length} settled markets from ${moments.length} decided moments, score log ${files.join(', ')}. ` +
  '"Before ≥97¢" counts markets whose winning side already traded at 97¢ or more when the log first showed the result. "Cheap" is taker buys of the winning side below 99¢ after that moment, with the edge they carried after the taker fee.', '',
  '"Last under 97¢" is the median seconds from that moment to the winning side\'s last print under 97¢; negative means the market moved first.', '',
  '| Group | Markets | Before ≥97¢ | No trades after | Last under 97¢ (s) | Median s to 99¢ | Cheap 0–30 s | Cheap 30 s–2 min | Cheap 2–15 min |', '|---|---|---|---|---|---|---|---|---|',
  ...table.map(g => `| ${g.group} | ${g.markets} | ${g.pricedBefore} | ${g.noTradesAfter} | ${g.medianLastUnder97 ?? '–'} | ${g.medianSecondsTo99 ?? '–'} | ${g.cheap.first30s.contracts} ($${g.cheap.first30s.edge}) | ${g.cheap.to2m.contracts} ($${g.cheap.to2m.edge}) | ${g.cheap.to15m.contracts} ($${g.cheap.to15m.edge}) |`)].join('\n') + '\n';
writeProjectFile('data/scores/lag-report.json', JSON.stringify({ files, table, results }, null, 2));
writeProjectFile('data/scores/lag-report.md', md);
console.log(md);
