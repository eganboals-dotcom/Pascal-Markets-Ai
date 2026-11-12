// Longshot, live (Agent C, every department): the favorite-longshot rules on paper. Every --list-minutes (15) it lists Kalshi's
// open events (about 107 pages, a minute), and every --every-seconds (60) it reads fresh prices for the markets that are in the
// half hour up to an hour before quoting would stop, the moment the history test reads them (src/agents/longshot.js). A market
// whose price falls in a bucket with a rule is bought on that side, one contract, held to settlement, as tested. The rules come
// from the history test's report (data/history/agents/longshot-report.json, its "next" rules); with none, nothing trades.
// On 60 days the rules made money settled but lost on closing-line value, so Gate C fails; this runs on paper to see which holds.
// There is no circuit breaker: most longshot trades lose by design, so a pause after any loss would stop it on the first settled
// trade. Department switches on the leaderboard turn their markets off. Trades go to data/paper/longshot.jsonl. No orders.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchMarkets, fetchOpenEvents, fetchSeries, getJson } from '../src/kalshi.js';
import { LEAD_MS, liveTrade } from '../src/agents/longshot.js';
import { quoteEnd, seriesOf } from '../src/history.js';
import { departmentOf, loadDepartments, readSwitches } from '../src/departments.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy, openLedger } from '../src/paper.js';
import { readResearch } from '../src/report.js';
import { MAX_BOOK_AGE_MS } from '../src/takers.js';

const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const everyMs = Number(option('every-seconds', 60)) * 1000, listMs = Number(option('list-minutes', 15)) * 60000;
const config = readResearch('config/scan.json', {}), mm = config.mm ?? {}, feeRate = config.feeRate ?? 0.07;
const AGENT = 'longshot', REPORT = 'data/history/agents/longshot-report.json', SETTLE_MS = 10 * 60000, DAY_MS = 86400000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail) => { try { beat(AGENT, state, detail, { nextWithinMs: 2 * Math.max(everyMs, listMs) }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const ledger = openLedger(AGENT), taken = new Set(ledger.trades.map(t => t.ticker));

// Open markets (times and volume, not prices), and series fees for the taker fee, each refreshed on its own clock.
let listed = { at: 0, markets: [] }, fees = { at: 0, bySeries: new Map() }, settledAt = 0;
const paced = async url => { await sleep(300); return getJson(url); }; // about 3 requests a second, beside the other live agents
async function refresh(now) {
  if (now - fees.at >= DAY_MS) {
    try { fees = { at: now, bySeries: new Map((await fetchSeries()).map(s => [s.ticker, s.fee_multiplier ?? 1])) }; } catch (error) { warn({ series: error.message }); }
  }
  if (now - listed.at < listMs) return;
  try { listed = { at: now, markets: (await fetchOpenEvents({ load: paced })).flatMap(e => e.markets ?? []) }; } catch (error) { warn({ list: error.message }); }
}

// Markets whose read window holds now or opens before the next pass, so their fresh prices are read inside the window.
const dueSoon = (m, now) => { const at = quoteEnd(m, mm) - LEAD_MS; return now <= at && now + everyMs > at - MAX_BOOK_AGE_MS; };

async function pass() {
  const now = Date.now(), departments = loadDepartments(), switches = readSwitches(departments);
  if (!flag('force') && downloadBusy()) { checkIn('waiting', 'Waiting for the history download'); say({ kalshi: 'waiting' }); return; }
  const rules = readResearch(REPORT, null)?.next ?? [];
  await refresh(now);
  if (now - settledAt >= SETTLE_MS) {
    settledAt = now;
    try { await ledger.settleDue((t, at) => at > Date.parse(t.expiry ?? t.closes)); } catch (error) { warn({ settle: error.message }); }
  }
  const due = listed.markets.filter(m => !taken.has(m.ticker) && Number(m.volume_fp) >= 1000 && dueSoon(m, now)
    && switches[departmentOf(seriesOf(m), departments)] !== false);
  let take = 0;
  for (let i = 0; rules.length && i < due.length; i += 50) {
    let fresh = [];
    try { fresh = await fetchMarkets(due.slice(i, i + 50).map(m => m.ticker)); } catch (error) { warn({ books: error.message }); continue; }
    for (const m of fresh) {
      const series = seriesOf(m) ?? m.ticker.split('-')[0];
      const t = liveTrade(m, rules, { now: Date.now(), mm, feeRate, feeMultiplier: fees.bySeries.get(series) ?? 1 });
      if (!t || taken.has(m.ticker)) continue;
      ledger.record({ time: Date.now(), ticker: m.ticker, league: series, department: departmentOf(series, departments), game: `${t.rule.label} buy ${t.side}`,
        start: null, side: t.side, price: t.price, fee: t.fee, edge: t.rule.mean, fair: null, books: null, offered: t.offered, contracts: 1,
        closes: m.close_time, expiry: m.expected_expiration_time ?? m.close_time });
      taken.add(m.ticker); take++;
    }
  }
  const open = ledger.open().length;
  checkIn('waiting', `${listed.markets.length} open markets listed, ${due.length} at their read time, ${take} new paper trades; `
    + `rules ${rules.map(r => `${r.label} ${r.side}`).join(', ') || 'none'}; ${ledger.trades.length} so far, ${open} open, ${ledger.settled.size} settled, ${money(ledger.pnl())}`);
  say({ listed: listed.markets.length, due: due.length, take, trades: ledger.trades.length, open, settled: ledger.settled.size, pnl: ledger.pnl(), ms: Date.now() - now });
}

say({ started: true, everySeconds: everyMs / 1000, listMinutes: listMs / 60000 });
for (;;) {
  const started = Date.now();
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, everyMs - (Date.now() - started)));
}
