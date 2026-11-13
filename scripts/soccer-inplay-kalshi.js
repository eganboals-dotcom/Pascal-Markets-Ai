// The in-play soccer totals model (src/agents/soccer-inplay.js) against Kalshi's real in-play trade prints. The model is fit on
// seasons before 2025-26 only. Kalshi's settled total-goals events from --from (2025-11-25, after the Becker data ends) to --to
// (2026-06-30) in the 50 leagues both cover are paired with the football-charts.com match by league, date (a day either way) and
// both team names; up to --per-league (30) pairs a league, spread over the window. For lines 0.5 to 3.5 it reads each market's
// prints from kickoff to 115 minutes after (cached in data/football-charts/kalshi-trades/), and reports the Brier score of
// Kalshi's price against the model's on the same moments, and a taker test: buying the side a taker bought when the model's
// chance beat that price plus the fee by each --margins value (0.03, 0.06, 0.10), one contract, held to settlement, with a 90%
// range from resampling matches. Writes data/football-charts/kalshi-report.{json,md}. No orders.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchTrades, getJson, kalshiFee } from '../src/kalshi.js';
import { fitModel, goalLag, parseMatches, scorePrints } from '../src/agents/soccer-inplay.js';
import { downloadBusy } from '../src/paper.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const from = Date.parse(option('from', '2025-11-25')), to = Date.parse(option('to', '2026-06-30')), perLeague = Number(option('per-league', 30));
const guardMin = Number(option('guard', 4)); // minutes left out around each goal's estimated time, against clock error
const margins = option('margins', '0.03,0.06,0.10').split(',').map(Number), LINES = [0.5, 1.5, 2.5, 3.5];
const BASE = 'https://api.elections.kalshi.com/trade-api/v2', CACHE = 'data/football-charts/kalshi-trades';
const SERIES = { premier: 'KXEPLTOTAL', spain1: 'KXLALIGATOTAL', italy1: 'KXSERIEATOTAL', germany1: 'KXBUNDESLIGATOTAL', france1: 'KXLIGUE1TOTAL',
  cha: 'KXEFLCHAMPIONSHIPTOTAL', holland1: 'KXEREDIVISIETOTAL', portugal1: 'KXLIGAPORTUGALTOTAL', eng1: 'KXEFLL1TOTAL', eng2: 'KXEFLL2TOTAL',
  spain2: 'KXLALIGA2TOTAL', germany2: 'KXBUNDESLIGA2TOTAL', france2: 'KXLIGUE2TOTAL', italy2: 'KXSERIEBTOTAL', 'scot-premier': 'KXSCOTTISHPREMTOTAL',
  egypt: 'KXEGYPLTOTAL', poland1: 'KXEKSTRAKLASATOTAL', austria1: 'KXAUTBUNDESTOTAL', japan1: 'KXJLEAGUETOTAL', japan2: 'KXJ2LEAGUETOTAL',
  korea1: 'KXKLEAGUETOTAL', korea2: 'KXK2LEAGUETOTAL', china: 'KXCHNSLTOTAL', morocco: 'KXBOTOLATOTAL', sweden1: 'KXALLSVENSKANTOTAL',
  finland1: 'KXFINYLTOTAL', serbia1: 'KXSRBSLTOTAL', turkey1: 'KXSUPERLIGTOTAL', turkey2: 'KXTFF1LIGTOTAL', belgium1: 'KXBELGIANPLTOTAL',
  denmark1: 'KXDENSUPERLIGATOTAL', swiss1: 'KXSWISSLEAGUETOTAL', greece1: 'KXSLGREECETOTAL', brazil1: 'KXBRASILEIROTOTAL', brazil2: 'KXBRASILEIROBTOTAL',
  saudi1: 'KXSAUDIPLTOTAL', australia: 'KXALEAGUETOTAL', czech1: 'KXCZEFLTOTAL', czech2: 'KXCZEFNLTOTAL', norway: 'KXELITESERIENTOTAL',
  holland2: 'KXEERSTEDIVTOTAL', romania1: 'KXROML1TOTAL', hungary1: 'KXHUNNB1TOTAL', bulgaria1: 'KXBULFLTOTAL', slovenia1: 'KXSVNPLTOTAL',
  germany3: 'KXGER3LTOTAL', national: 'KXENGNLTOTAL', italy3a: 'KXSERIECTOTAL', india1: 'KXINDSLTOTAL', thai1: 'KXTHAIL1TOTAL' };

if (downloadBusy()) { console.log('The history download is using Kalshi\'s request limit; run this after it finishes.'); process.exit(0); }
const matches = parseMatches(readFileSync(projectPath('data/football-charts/football_charts_matches.csv'), 'utf8'));
const model = fitModel(matches.filter(m => !['2025-2026', '2025', '2026'].includes(m.season)));
mkdirSync(projectPath(CACHE), { recursive: true });

// Team names: accents and punctuation off, short words and club tags dropped; two names agree when a word of one starts the other's.
const STOP = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'club', 'the', 'cd', 'ud', 'sv', 'fk', 'sk', 'nk', 'bk', 'if', 'de', 'utd', 'city', 'united', 'town', 'real', 'sporting', 'athletic']);
const words = name => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
const agree = (a, b) => { const x = words(a), y = words(b); return x.some(u => y.some(v => u.startsWith(v.slice(0, 4)) && v.startsWith(u.slice(0, 4)))); };
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const tickerDay = t => { const d = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return d ? Date.UTC(2000 + Number(d[1]), MONTHS[d[2]], Number(d[3])) : NaN; };

async function settledEvents(series) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 40; page++) {
    const body = await getJson(`${BASE}/events?series_ticker=${series}&status=settled&limit=200&with_nested_markets=true${cursor ? `&cursor=${cursor}` : ''}`);
    const events = body.events ?? [];
    out.push(...events.filter(e => tickerDay(e.event_ticker) >= from - 86400000 && tickerDay(e.event_ticker) <= to));
    cursor = body.cursor;
    if (!cursor || !events.length || events.every(e => tickerDay(e.event_ticker) < from - 86400000)) break;
    await sleep(200);
  }
  return out;
}

function pair(event, pool) {
  const [home, away] = (event.title ?? '').replace(/:.*$/, '').split(/\s+(?:vs\.?|at)\s+/i); // "Home vs Away" or "Away at Home"
  if (!home || !away) return null;
  const day = tickerDay(event.event_ticker);
  return pool.find(m => m.kickoff && Math.abs(Date.parse(m.date) - day) <= 86400000 && ((agree(home, m.home) && agree(away, m.away)) || (agree(home, m.away) && agree(away, m.home)))) ?? null;
}

async function prints(ticker, kickoff) {
  const path = projectPath(`${CACHE}/${ticker}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  // Markets settled before Kalshi's historical cutoff (2026-09-13 on Nov 12) keep their prints only on /historical/trades.
  const fromHistory = url => getJson(url.replace('/markets/trades?', '/historical/trades?'));
  // A wide window, so the clock check can see a kickoff time that is hours off.
  let trades = await fetchTrades(ticker, kickoff - 180 * 60000, getJson, 5, kickoff + 240 * 60000);
  if (!trades.length) trades = await fetchTrades(ticker, kickoff - 180 * 60000, fromHistory, 5, kickoff + 240 * 60000);
  trades = trades.map(t => ({ created_time: t.created_time, yes_price_dollars: t.yes_price_dollars, count_fp: t.count_fp, taker_side: t.taker_side }));
  writeFileSync(path, JSON.stringify(trades));
  await sleep(150);
  return trades;
}

// Settled events listed in bulk come without their markets; older ones keep them only on /historical/markets.
async function marketsOf(e) {
  if (e.markets?.length) return e.markets;
  try {
    let body = await getJson(`${BASE}/markets?event_ticker=${e.event_ticker}`);
    if (!body.markets?.length) body = await getJson(`${BASE}/historical/markets?event_ticker=${e.event_ticker}`);
    await sleep(150);
    return body.markets ?? [];
  } catch (error) { console.error(e.event_ticker, error.message); return []; }
}
const fee = price => kalshiFee(1, price);
const results = [], leagues = [];
const only = option('leagues', '') ? new Set(option('leagues').split(',')) : null; // --leagues=premier,spain1 for a short run
for (const [league, series] of Object.entries(SERIES).filter(([l]) => !only || only.has(l))) {
  let events;
  try { events = await settledEvents(series); } catch (error) { console.error(series, error.message); continue; }
  const pool = matches.filter(m => m.league === league && Date.parse(m.date) >= from - 86400000 && Date.parse(m.date) <= to);
  const paired = events.map(e => ({ e, m: pair(e, pool) })).filter(x => x.m).sort((a, b) => a.m.kickoff - b.m.kickoff);
  const step = Math.max(1, paired.length / perLeague), chosen = Array.from({ length: Math.min(perLeague, paired.length) }, (_, i) => paired[Math.floor(i * step)]);
  leagues.push({ league, series, events: events.length, paired: paired.length, used: chosen.length });
  console.log(JSON.stringify(leagues.at(-1)));
  for (const { e, m } of chosen) for (const x of await marketsOf(e)) {
    const line = Number(x.floor_strike);
    if (!LINES.includes(line) || !['yes', 'no'].includes(x.result)) continue;
    // A settlement that disagrees with the dataset's final score means a wrong pairing or a different count; leave it out.
    if ((m.total > line ? 'yes' : 'no') !== x.result) { results.push({ league, ticker: x.ticker, mismatch: true }); continue; }
    let trades;
    try { trades = await prints(x.ticker, m.kickoff); } catch (error) { console.error(x.ticker, error.message); continue; }
    const scored = Object.fromEntries(margins.map(margin => [margin, scorePrints(m, { line, result: x.result }, trades, model, fee, { margin, guardMin }).picks]));
    results.push({ league, ticker: x.ticker, match: `${m.date} ${m.home} v ${m.away}`, line, lag: goalLag(m, { line, result: x.result }, trades), rows: scorePrints(m, { line, result: x.result }, trades, model, fee, { guardMin }).rows, picks: scored });
  }
}

// The clock check: a league counts only when Kalshi's settle jumps after deciding goals fall, at the median, within 5 minutes of
// the goals' likely times (at least 3 checks), so a wrong kickoff time zone or clock cannot pass as an edge.
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
for (const l of leagues) {
  const lags = results.filter(r => r.league === l.league && Number.isFinite(r.lag)).map(r => r.lag);
  Object.assign(l, { checks: lags.length, medianLag: median(lags), clockOk: lags.length >= 3 && Math.abs(median(lags)) <= 5 });
}
const clockOk = new Set(leagues.filter(l => l.clockOk).map(l => l.league));
// Scores, and a 90% range for each margin's P&L from resampling matches.
const good = results.filter(r => !r.mismatch && clockOk.has(r.league)), rows = good.flatMap(r => r.rows);
const brier = k => rows.reduce((a, r) => a + (r[k] - r.over) ** 2, 0) / rows.length;
const byMatch = new Map();
for (const r of good) byMatch.set(r.match, [...(byMatch.get(r.match) ?? []), r]);
const matchList = [...byMatch.values()];
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const tests = margins.map(margin => {
  const per = matchList.map(rs => rs.flatMap(r => r.picks[margin]).reduce((a, p) => a + p.pnl, 0)), picks = good.flatMap(r => r.picks[margin]);
  const sims = Array.from({ length: 1000 }, () => per.reduce(a => a + per[Math.floor(rand() * per.length)], 0)).sort((a, b) => a - b);
  const side = s => { const ps = picks.filter(p => p.side === s); return { n: ps.length, pnl: ps.reduce((a, p) => a + p.pnl, 0) }; };
  return { margin, trades: picks.length, pnl: per.reduce((a, b) => a + b, 0), low: sims[50], high: sims[949], meanEdge: picks.length ? picks.reduce((a, p) => a + p.edge, 0) / picks.length : 0, yes: side('yes'), no: side('no') };
});
const summary = { matches: matchList.length, markets: good.length, mismatched: results.filter(r => r.mismatch).length, moments: rows.length, brierKalshi: brier('yes'), brierModel: brier('p') };
const money = x => `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`;
const md = ['# In-play soccer totals: the model against Kalshi', '',
  `${summary.matches} matches (${summary.markets} markets, lines 0.5–3.5) in ${clockOk.size} leagues whose clock check passed (of ${leagues.filter(l => l.used).length} tried), ${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}; ` +
  `${summary.mismatched} markets left out because Kalshi's settlement disagreed with the dataset's score. On ${summary.moments} in-play moments (one a market per 5 minutes, away from goals and the break) ` +
  `Kalshi's price scores a Brier of ${summary.brierKalshi.toFixed(4)} and the model ${summary.brierModel.toFixed(4)} (lower is better).`, '',
  '| Edge needed | Trades | P&L, one contract each | 90% range | Mean edge | Yes trades (P&L) | No trades (P&L) |', '|---|---|---|---|---|---|---|',
  ...tests.map(t => `| ${(100 * t.margin).toFixed(0)}¢ | ${t.trades} | ${money(t.pnl)} | ${money(t.low)} to ${money(t.high)} | ${(100 * t.meanEdge).toFixed(1)}¢ | ${t.yes.n} (${money(t.yes.pnl)}) | ${t.no.n} (${money(t.no.pnl)}) |`), '',
  '| League | Series | Events in window | Paired | Used | Clock checks | Median settle lag (min) | Kept |', '|---|---|---|---|---|---|---|---|', ...leagues.map(l => `| ${l.league} | ${l.series} | ${l.events} | ${l.paired} | ${l.used} | ${l.checks} | ${l.medianLag === null ? '–' : l.medianLag.toFixed(1)} | ${l.clockOk ? 'yes' : 'no'} |`)].join('\n') + '\n';
writeProjectFile('data/football-charts/kalshi-report.json', JSON.stringify({ summary, tests, leagues, results: good.map(({ rows: _, ...r }) => r) }, null, 2));
writeProjectFile('data/football-charts/kalshi-report.md', md);
console.log(md);
