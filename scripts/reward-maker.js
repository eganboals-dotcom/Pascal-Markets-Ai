// Reward-maker, live on paper: resting bids on both sides of the markets with the richest Kalshi liquidity incentive programs, to
// measure what the rewards pay against what fills cost (src/agents/reward-maker.js has the scoring rules). Every --list-minutes (30)
// it lists the active liquidity programs, reads the books of the --candidates (200) best-paying markets, and keeps the --markets (40)
// where a fresh --size (10) bid at each side's Reference Price would earn the most. Every --every-seconds (60) it:
//   1. reads the exchange-wide trade tape since the last pass and fills the resting bids it traded through (after the line ahead);
//   2. reads each kept market's book, scores the bids that rested through the last interval as one snapshot (Kalshi takes one a
//      second; a minute's worth is credited from one), and accrues that share of the program's pool for the time since the last pass;
//   3. moves each bid to the side's Reference Price where it no longer scores in full, at the back of that price's line.
// Fills are held to settlement with the maker fee charged. A market stops bidding a side once its net position reaches
// --max-inventory contracts that way. A program that ends with under $1 accrued pays nothing (the program's minimum).
// An event (all strikes of one market) whose fills, at the mid or settled, have cost over --toxic-limit ($1) more than its rewards
// paid stops being bid (src/agents/reward-maker.js toxicEvents).
// Fills go to data/paper/reward-maker-fills.jsonl, everything else to reward-maker-state.json. No orders.
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fetchIncentivePrograms, fetchMarkets, fetchOrderbook, fetchTrades, getJson, kalshiFee } from '../src/kalshi.js';
import { recordTape } from '../src/mm-recorder.js';
import { DAY_MS, eventKey, fillBid, fillPnl, netYes, toxicEvents, parseBook, programDiscount, programPerDay, programTarget, restingBid, snapshotShare } from '../src/agents/reward-maker.js';
import { departmentOf, loadDepartments, readSwitches, seriesOf } from '../src/departments.js';
import { settlementValue } from '../src/history.js';
import { beat } from '../src/heartbeat.js';
import { downloadBusy } from '../src/paper.js';
import { readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const flag = name => process.argv.includes(`--${name}`);
const everyMs = option('every-seconds', 60) * 1000, listMs = option('list-minutes', 30) * 60000;
const SIZE = option('size', 10), MARKETS = option('markets', 40), CANDIDATES = option('candidates', 200), MAX_INV = option('max-inventory', 30);
const TOXIC = option('toxic-limit', 1); // dollars an event may lose net of its rewards before it stops being bid
const makerFeeRate = readResearch('config/scan.json', {}).makerFeeRate ?? 0.0175;
const AGENT = 'reward-maker', FILLS = 'data/paper/reward-maker-fills.jsonl', STATE = 'data/paper/reward-maker-state.json', SETTLE_MS = 10 * 60000;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const checkIn = (state, detail) => { try { beat(AGENT, state, detail, { nextWithinMs: 3 * everyMs + 5 * 60000 }); } catch (error) { warn({ heartbeat: error.message }); } };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
const paced = async url => { await sleep(300); return getJson(url); }; // about 3 requests a second, beside the other live agents

mkdirSync(projectPath('data/paper'), { recursive: true });
const fills = existsSync(projectPath(FILLS)) ? readFileSync(projectPath(FILLS), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const saved = readResearch(STATE, {});
// programs: id -> { ticker, perDay, target, discount, start, end, accrued, chosen }; orders: ticker -> { yes, no }; marks: ticker -> Yes mid.
const state = { startedAt: saved.startedAt ?? Date.now(), programs: saved.programs ?? {}, chosen: saved.chosen ?? [], orders: saved.orders ?? {},
  outcomes: saved.outcomes ?? {}, marks: saved.marks ?? {}, listedAt: saved.listedAt ?? 0, lastPass: saved.lastPass ?? 0 };
let tape = saved.tape ? { time: saved.tape.time, ids: new Set(saved.tape.ids) } : null, settledAt = 0;
const save = () => writeProjectFile(STATE, JSON.stringify({ ...state, tape: tape && { time: tape.time, ids: [...tape.ids] } }) + '\n');
const toxic = () => toxicEvents(fills, Object.values(state.programs), t => state.outcomes[t] ?? state.marks[t], TOXIC);
const programOf = ticker => Object.entries(state.programs).find(([, p]) => p.ticker === ticker && p.chosen);

// Lists the programs and keeps the markets where fresh bids would earn the most. Accrued rewards stay with their program ids.
async function choose(now) {
  const departments = loadDepartments(), switches = readSwitches(departments), blocked = toxic();
  const live = (await fetchIncentivePrograms({ load: paced })).filter(p => Date.parse(p.start_date) <= now && now < Date.parse(p.end_date)
    && programTarget(p) > 0 && !blocked.has(eventKey(p.market_ticker)) && switches[departmentOf(seriesOf(p.market_ticker), departments)] !== false);
  const best = new Map();
  for (const p of live) if (!best.has(p.market_ticker) || programPerDay(p) > programPerDay(best.get(p.market_ticker))) best.set(p.market_ticker, p);
  const scored = [];
  for (const p of [...best.values()].sort((a, b) => programPerDay(b) - programPerDay(a)).slice(0, CANDIDATES)) {
    let book;
    try { book = parseBook(await fetchOrderbook(p.market_ticker, paced)); } catch (error) { warn({ book: p.market_ticker, error: error.message }); continue; }
    const target = programTarget(p), bids = { yes: restingBid(book.yes, target, null, SIZE, now), no: restingBid(book.no, target, null, SIZE, now) };
    const share = bids.yes && bids.no ? snapshotShare(book, target, programDiscount(p), bids) : 0;
    if (share > 0) scored.push({ p, perDay: programPerDay(p) * share });
  }
  scored.sort((a, b) => b.perDay - a.perDay);
  const kept = scored.slice(0, MARKETS);
  for (const entry of Object.values(state.programs)) entry.chosen = false;
  for (const { p } of kept) {
    state.programs[p.id] = { ...(state.programs[p.id] ?? { accrued: 0 }), ticker: p.market_ticker, perDay: programPerDay(p), target: programTarget(p),
      discount: programDiscount(p), start: Date.parse(p.start_date), end: Date.parse(p.end_date), chosen: true };
  }
  state.chosen = kept.map(s => s.p.market_ticker);
  for (const ticker of Object.keys(state.orders)) if (!state.chosen.includes(ticker)) delete state.orders[ticker]; // cancelled
  state.listedAt = now;
  return { programs: live.length, candidates: Math.min(best.size, CANDIDATES), scored: scored.length, estimatePerDay: +kept.reduce((a, s) => a + s.perDay, 0).toFixed(2) };
}

function applyFills(trades) {
  const byTicker = Map.groupBy(trades, t => t.ticker);
  let count = 0;
  for (const [ticker, orders] of Object.entries(state.orders)) {
    const prints = byTicker.get(ticker) ?? [];
    for (const side of ['yes', 'no']) {
      if (!orders[side] || !prints.length) continue;
      const r = fillBid(orders[side], side, prints);
      orders[side] = r.order;
      for (const f of r.fills) {
        const row = { ...f, ticker, fee: kalshiFee(f.contracts, f.price, makerFeeRate), program: programOf(ticker)?.[0] ?? null };
        appendFileSync(projectPath(FILLS), JSON.stringify(row) + '\n'); fills.push(row); count++;
      }
    }
  }
  return count;
}

async function settle(now) {
  const due = [...new Set(fills.map(f => f.ticker))].filter(t => !(t in state.outcomes));
  settledAt = now;
  if (!due.length) return;
  for (const m of await fetchMarkets(due, paced)) { const v = settlementValue(m); if (v !== null) state.outcomes[m.ticker] = v; }
}

function totals(now) {
  let accrued = 0, forfeited = 0;
  for (const p of Object.values(state.programs)) if (p.end <= now && p.accrued < 1) forfeited += p.accrued; else accrued += p.accrued;
  let settledPnl = 0, openMarked = 0, openCost = 0, contracts = 0;
  const settledMarkets = new Set();
  for (const f of fills) {
    contracts += f.contracts;
    const outcome = state.outcomes[f.ticker];
    if (outcome === 0 || outcome === 1) { settledPnl += fillPnl(f, outcome, f.fee); settledMarkets.add(f.ticker); continue; }
    openCost += f.contracts * f.price + f.fee;
    const mid = state.marks[f.ticker];
    if (Number.isFinite(mid)) openMarked += fillPnl(f, mid, f.fee); // valued at the Yes mid, as a fractional payout
  }
  let resting = 0;
  for (const o of Object.values(state.orders)) for (const side of ['yes', 'no']) if (o[side]) resting += o[side].size * o[side].price;
  return { accrued, forfeited, fills: fills.length, contracts, settledPnl, settledMarkets: settledMarkets.size, openMarked, cash: resting + openCost };
}

async function pass() {
  const now = Date.now();
  if (!flag('force') && downloadBusy()) { checkIn('waiting', 'Waiting for the history download'); say({ kalshi: 'waiting' }); return; }
  if (now - state.listedAt >= listMs || !state.chosen.length) {
    try { say({ chose: await choose(now) }); } catch (error) { warn({ choose: error.message }); }
  }
  // 1. Fills from the tape since the last pass.
  if (!tape) tape = { time: now - everyMs, ids: new Set() };
  let filled = 0;
  try {
    const result = await recordTape(tape, new Set(Object.keys(state.orders)), (t, since, _l, pages) => fetchTrades(t, since, paced, pages));
    tape = result.cursor;
    if (result.truncated) warn({ tape: 'truncated: the oldest prints since the last pass were lost' });
    filled = applyFills(result.rows);
  } catch (error) { warn({ tape: error.message }); }
  // 2 and 3. Score the bids that rested through the interval on each book, then move them where needed.
  const interval = state.lastPass ? Math.min(now - state.lastPass, 3 * everyMs) : 0;
  let earned = 0, quoted = 0;
  const blocked = toxic();
  for (const ticker of state.chosen) {
    const p = programOf(ticker)?.[1];
    if (!p) continue;
    if (blocked.has(eventKey(ticker))) { delete state.orders[ticker]; continue; } // cancelled: the toxicity stop
    let book;
    try { book = parseBook(await fetchOrderbook(ticker, paced)); } catch (error) { warn({ book: ticker, error: error.message }); continue; }
    const orders = state.orders[ticker] ?? {};
    if (book.yes[0] && book.no[0]) state.marks[ticker] = (book.yes[0][0] + 1 - book.no[0][0]) / 2;
    if (now >= p.start && now < p.end && orders.yes && orders.no && interval > 0) {
      const credit = p.perDay * snapshotShare(book, p.target, p.discount, orders) * interval / DAY_MS;
      p.accrued += credit; earned += credit;
    }
    const net = netYes(fills.filter(f => f.ticker === ticker));
    state.orders[ticker] = {
      yes: net < MAX_INV ? restingBid(book.yes, p.target, orders.yes, SIZE, Date.now()) : null,
      no: net > -MAX_INV ? restingBid(book.no, p.target, orders.no, SIZE, Date.now()) : null,
    };
    if (state.orders[ticker].yes || state.orders[ticker].no) quoted++;
  }
  state.lastPass = now;
  if (now - settledAt >= SETTLE_MS) { try { await settle(now); } catch (error) { warn({ settle: error.message }); } }
  save();
  const t = totals(now);
  checkIn('quoting', `${quoted} of ${state.chosen.length} markets bid at ${SIZE} a side${blocked.size ? ` (${blocked.size} events stopped as toxic)` : ''}; rewards ${money(t.accrued)} accrued`
    + `${t.forfeited ? ` (${money(t.forfeited)} lost to the $1 minimum)` : ''}, ${money(earned)} this pass; ${t.fills} fills (${t.contracts} contracts), `
    + `settled ${money(t.settledPnl)} on ${t.settledMarkets} markets, open ${money(t.openMarked)} at the mid; cash held ${money(t.cash)}`);
  say({ quoted, filled, toxic: blocked.size, earned: +earned.toFixed(4), accrued: +t.accrued.toFixed(2), forfeited: +t.forfeited.toFixed(2), fills: t.fills,
    settledPnl: +t.settledPnl.toFixed(2), openMarked: +t.openMarked.toFixed(2), cash: +t.cash.toFixed(0), ms: Date.now() - now });
}

say({ started: true, everySeconds: everyMs / 1000, listMinutes: listMs / 60000, size: SIZE, markets: MARKETS });
for (;;) {
  const started = Date.now();
  try { await pass(); } catch (error) { warn({ error: error.message }); checkIn('error', error.message); }
  if (flag('once')) break;
  await sleep(Math.max(0, everyMs - (Date.now() - started)));
}
