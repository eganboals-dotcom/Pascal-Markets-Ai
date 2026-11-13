// In-play fair value for soccer goal totals, from the football-charts.com goal-timing data (CC BY 4.0, data/football-charts/):
// the goals still to come in regulation are Poisson with mean = the league's goals per match x the share of all goals scored after
// the current minute. Stoppage-time goals are recorded as 45 and 90, so minute 45 is half time and 90 is the end. Pure functions;
// scripts/soccer-inplay-fit.js checks calibration on a held-out season and scripts/soccer-inplay-kalshi.js compares with Kalshi.

// One CSV line into fields (quoted fields may hold commas).
function fields(line) {
  const out = [];
  let cur = '', quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// The data's kickoff times are Central European local time, not UTC as its notes say: Kalshi's prices move at the goals 60 minutes
// (winter) or 120 minutes (summer) before the listed times read as UTC. This turns a Berlin date and time into UTC milliseconds.
const BERLIN = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const berlinOffset = ms => { const p = Object.fromEntries(BERLIN.formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
export function centralEuropean(date, time) {
  const guess = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(guess)) return NaN;
  const first = guess - berlinOffset(guess);
  return guess - berlinOffset(first); // a second pass settles the hours next to a daylight-saving change
}

// Matches with every goal timed: { league, season, date, kickoff (ms, UTC, or null), home, away, goals, elapsed, total }. The data
// gives stoppage-time goals their real minute (47 in the first half, 95 in the second), so the half-time score says which half each
// goal fell in: goals holds the clock minute (first-half stoppage as 45, second half 46 to 90) and elapsed the likely minutes after
// kickoff (second-half minutes plus 18 for the break and first-half stoppage).
export function parseMatches(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/), keys = fields(head);
  const matches = [];
  for (const line of lines) {
    const r = Object.fromEntries(fields(line).map((v, i) => [keys[i], v])), total = Number(r.total_goals);
    const raw = (r.all_goal_times ?? '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
    const half = (r.ht_result ?? '').split(':').map(Number), firstHalf = half[0] + half[1];
    if (!Number.isInteger(total) || raw.length !== total || raw.some(m => !(m >= 1 && m <= 130)) || !(Number.isInteger(firstHalf) && firstHalf <= total)) continue;
    if (raw.slice(0, firstHalf).some(m => m > 55) || raw.slice(firstHalf).some(m => m < 46)) continue; // minutes that disagree with the half-time score
    const goals = raw.map((m, i) => i < firstHalf ? Math.min(m, 45) : Math.min(m, 90));
    const elapsed = raw.map((m, i) => i < firstHalf ? m : m + 18);
    const kickoff = r.time ? centralEuropean(r.match_date, r.time) : NaN;
    matches.push({ league: r.league, season: r.season, date: r.match_date, kickoff: Number.isFinite(kickoff) ? kickoff : null, home: r.home_team, away: r.away_team, goals, elapsed, total });
  }
  return matches;
}

// share[t] = the share of goals scored after minute t (t = 0..90); rate per league, shrunk toward the overall mean by `prior`
// matches' worth of weight, so a small league does not swing on a few high-scoring games.
export function fitModel(matches, { prior = 50 } = {}) {
  const byMinute = new Array(91).fill(0);
  for (const m of matches) for (const g of m.goals) byMinute[g]++;
  const all = byMinute.reduce((a, b) => a + b, 0), share = [];
  let after = all;
  for (let t = 0; t <= 90; t++) { after -= byMinute[t]; share[t] = all ? after / all : 0; }
  const overall = matches.length ? all / matches.length : 0, sums = new Map();
  for (const m of matches) { const s = sums.get(m.league) ?? [0, 0]; s[0] += m.total; s[1]++; sums.set(m.league, s); }
  const rate = new Map([...sums].map(([league, [goals, n]]) => [league, (goals + prior * overall) / (n + prior)]));
  return { share, rate, overall };
}

const poissonAtMost = (k, mu) => { let term = Math.exp(-mu), sum = term; for (let i = 1; i <= k; i++) { term *= mu / i; sum += term; } return sum; };

// The chance the regulation total ends above `line` (2.5 for Over 2.5), at match minute `minute` with `scored` goals so far.
export function overChance(model, league, minute, scored, line) {
  const need = Math.floor(line - scored); // more goals than this are needed
  if (need < 0) return 1;
  const mu = (model.rate.get(league) ?? model.overall) * model.share[Math.max(0, Math.min(90, Math.floor(minute)))];
  return 1 - poissonAtMost(need, mu);
}

// Match minute from minutes since kickoff: the first half runs about 47 minutes with stoppage time and the break about 15, so the
// clock reads 45 from 47 to 63 minutes after kickoff and minute = elapsed − 18 after that. Null before kickoff or after about 115.
// shortcut: stoppage times vary by a few minutes; callers leave out moments near a goal or a half's edge.
export function minuteAt(elapsed) {
  if (!(elapsed >= 0) || elapsed > 115) return null;
  if (elapsed <= 45) return elapsed;
  if (elapsed < 63) return 45;
  return Math.min(90, elapsed - 18);
}
// The other way: minutes after kickoff at which a goal in match minute `minute` was scored (its likely real time).
export const elapsedAt = minute => minute <= 45 ? minute : minute + 18;

// A clock check for one market an Over won: minutes from the deciding goal's likely time to the first print at 97¢ or more after
// which the Yes price stays at 90¢ or more. Near zero (a minute or so) when the kickoff time and goal minutes line up with Kalshi.
export function goalLag(match, market, trades) {
  if (market.result !== 'yes' || match.total <= market.line) return null;
  const goal = (match.elapsed ?? match.goals.map(elapsedAt))[Math.floor(market.line)], prices = [...trades]
    .map(t => ({ time: Date.parse(t.created_time), yes: Number(t.yes_price_dollars) })).sort((a, b) => a.time - b.time);
  let lowAfter = Infinity, jump = null;
  for (let i = prices.length - 1; i >= 0; i--) { if (prices[i].yes >= 0.97 && lowAfter >= 0.9) jump = prices[i]; lowAfter = Math.min(lowAfter, prices[i].yes); }
  return jump && Number.isFinite(goal) ? (jump.time - match.kickoff) / 60000 - goal : null;
}

// One Kalshi total market's in-play prints against the model. match = { league, kickoff, goals }, market = { line, result }.
// A print counts when the clock is known well enough: not within guardMin of a goal's likely time, not at a half's edges, not past
// 108 minutes after kickoff, and with the line not yet passed. In each bucketMin of the match it keeps the first such print as a
// calibration row { p, yes, over }, and the first taker print that a buyer could have matched with an edge after the fee above
// margin as a pick { side, price, fee, edge, pnl }. fee(price) is the taker fee per contract.
// guardBefore (default guardMin) also skips the minutes before a goal, which only hindsight knows: it drops the No bets a coming goal
// would lose, so an honest test of what a live agent could do sets it to 0 and lets guardMin cover clock error after the goal.
export function scorePrints(match, market, trades, model, fee, { margin = 0.03, guardMin = 4, guardBefore = guardMin, bucketMin = 5 } = {}) {
  const over = market.result === 'yes' ? 1 : 0, rows = [], picks = [], rowBuckets = new Set(), pickBuckets = new Set();
  const goalTimes = match.elapsed ?? match.goals.map(elapsedAt);
  for (const t of [...trades].sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time))) {
    const elapsed = (Date.parse(t.created_time) - match.kickoff) / 60000, minute = minuteAt(elapsed), yes = Number(t.yes_price_dollars);
    if (minute === null || elapsed < 1 || elapsed > 108 || (elapsed >= 44 && elapsed <= 49) || (elapsed >= 60 && elapsed <= 66) || !(yes > 0 && yes < 1)) continue;
    if (goalTimes.some(g => elapsed > g - guardBefore && elapsed < g + guardMin)) continue;
    const scored = goalTimes.filter(g => g < elapsed).length;
    if (scored > market.line) continue;
    const p = overChance(model, match.league, minute, scored, market.line), bucket = Math.floor(elapsed / bucketMin);
    if (!rowBuckets.has(bucket)) { rowBuckets.add(bucket); rows.push({ minute, p, yes, over }); }
    const side = t.taker_side === 'yes' ? 'yes' : t.taker_side === 'no' ? 'no' : null;
    if (!side || pickBuckets.has(bucket)) continue;
    const price = side === 'yes' ? yes : 1 - yes, chance = side === 'yes' ? p : 1 - p, f = fee(price), edge = chance - price - f;
    if (edge > margin) { pickBuckets.add(bucket); picks.push({ minute, side, price, fee: f, edge, pnl: (side === 'yes' ? over : 1 - over) - price - f }); }
  }
  return { rows, picks };
}
