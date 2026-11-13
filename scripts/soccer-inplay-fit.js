// Calibration of the in-play soccer totals model (src/agents/soccer-inplay.js) on a season it never saw. It fits on the older
// seasons of the football-charts.com data and scores the newest (2025-2026, 2025 and 2026) at minutes 0, 15, 30, 45, 60, 70, 80
// and 85 for every total line 0.5 to 4.5 not yet passed: the model's chance against how often the Over came in, by chance band and
// by minute, with its Brier score beside a lookup table of the training seasons' own Over rates for the same minute, goals still
// needed and league. Writes data/football-charts/fit-report.{json,md}. Usage: node scripts/soccer-inplay-fit.js
import { readFileSync } from 'node:fs';
import { fitModel, overChance, parseMatches } from '../src/agents/soccer-inplay.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const TEST = new Set(['2025-2026', '2025', '2026']), MINUTES = [0, 15, 30, 45, 60, 70, 80, 85], LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const matches = parseMatches(readFileSync(projectPath('data/football-charts/football_charts_matches.csv'), 'utf8'));
const train = matches.filter(m => !TEST.has(m.season)), test = matches.filter(m => TEST.has(m.season)), model = fitModel(train);

// Every undecided (minute, line) moment of a match: goals so far, goals needed beyond the line, and whether the Over came in.
const moments = m => MINUTES.flatMap(minute => {
  const scored = m.goals.filter(g => g <= minute).length;
  return LINES.filter(line => scored < line).map(line => ({ minute, line, scored, need: Math.floor(line - scored) + 1, over: m.total > line ? 1 : 0 }));
});
// The lookup baseline: the training Over rate for the same minute, goals needed and league (falling back to all leagues).
const table = new Map(), key = (...k) => k.join('|');
for (const m of train) for (const x of moments(m)) for (const k of [key(x.minute, x.need, m.league), key(x.minute, x.need)]) {
  const t = table.get(k) ?? [0, 0]; t[0] += x.over; t[1]++; table.set(k, t);
}
const lookup = (league, x) => { const t = table.get(key(x.minute, x.need, league)); return t && t[1] >= 30 ? t[0] / t[1] : (([o, n]) => o / n)(table.get(key(x.minute, x.need)) ?? [0, 1]); };

const rows = test.flatMap(m => moments(m).map(x => ({ ...x, p: overChance(model, m.league, x.minute, x.scored, x.line), q: lookup(m.league, x) })));
const brier = (k, rs) => rs.reduce((a, r) => a + (r[k] - r.over) ** 2, 0) / rs.length;
const bands = Array.from({ length: 10 }, (_, i) => {
  const rs = rows.filter(r => r.p >= i / 10 && (r.p < (i + 1) / 10 || (i === 9 && r.p <= 1)));
  return { band: `${i * 10}–${i * 10 + 10}%`, n: rs.length, predicted: rs.length ? rs.reduce((a, r) => a + r.p, 0) / rs.length : null, actual: rs.length ? rs.reduce((a, r) => a + r.over, 0) / rs.length : null };
});
const byMinute = MINUTES.map(minute => { const rs = rows.filter(r => r.minute === minute);
  return { minute, n: rs.length, predicted: rs.reduce((a, r) => a + r.p, 0) / rs.length, actual: rs.reduce((a, r) => a + r.over, 0) / rs.length, brierModel: brier('p', rs), brierTable: brier('q', rs) }; });
const pct = x => x === null ? '–' : `${(100 * x).toFixed(1)}%`;
const summary = { trainMatches: train.length, testMatches: test.length, moments: rows.length, brierModel: brier('p', rows), brierTable: brier('q', rows), overall: model.overall };
const md = ['# In-play soccer totals model: held-out calibration', '',
  `Fit on ${train.length} matches (seasons before 2025-26), scored on ${test.length} matches of 2025-26, 2025 and 2026: ${rows.length} undecided moments. ` +
  `Brier score ${summary.brierModel.toFixed(4)} for the model, ${summary.brierTable.toFixed(4)} for the lookup table of training Over rates (lower is better).`, '',
  '| Model chance | Moments | Predicted | Over came in |', '|---|---|---|---|', ...bands.map(b => `| ${b.band} | ${b.n} | ${pct(b.predicted)} | ${pct(b.actual)} |`), '',
  '| Minute | Moments | Predicted | Over came in | Brier model | Brier table |', '|---|---|---|---|---|---|',
  ...byMinute.map(b => `| ${b.minute} | ${b.n} | ${pct(b.predicted)} | ${pct(b.actual)} | ${b.brierModel.toFixed(4)} | ${b.brierTable.toFixed(4)} |`)].join('\n') + '\n';
writeProjectFile('data/football-charts/fit-report.json', JSON.stringify({ summary, bands, byMinute }, null, 2));
writeProjectFile('data/football-charts/fit-report.md', md);
console.log(md);
