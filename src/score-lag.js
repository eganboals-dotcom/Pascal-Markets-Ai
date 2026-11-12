// How fast Kalshi reprices a market after its own live score has decided it. From score-watch's score log (data/scores/) it finds
// the first moment the log showed a market decided, and from Kalshi's public trade prints it measures what traded after that
// moment: how long until the winning side traded at 99¢, and how many contracts takers still bought on the winning side below
// 99¢ (volume a faster taker could have had). Used by scripts/score-lag.js.
import { ESPORTS_TYPE, SOCCER_TYPE, SPORTS, TABLE_TENNIS_TYPE, TENNIS_TYPE, seriesOf } from './agents/score-watch.js';

const FINAL_KINDS = new Set(['MATCH', 'GAME']);
const suffix = event => Number(event.split('-').at(-1));

// The decided moments in one day's score log rows. Each is { id, type, event, label, time, goals? }: every market of `event` is
// decided at `time` (for a soccer goal, only the total markets whose line the goal passed). A milestone's first row is skipped,
// since what it shows happened before the log saw the match.
export function decisionMoments(rows) {
  const byId = new Map();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const moments = [];
  for (const list of byId.values()) {
    list.sort((a, b) => a.time - b.time);
    const { type, events = [] } = list[0], kind = e => SPORTS[type]?.kind(seriesOf(e));
    const first = (test, label, pick, extra = {}) => {
      const i = list.findIndex(r => test(r.score));
      if (i <= 0) return;
      for (const event of events.filter(pick)) moments.push({ id: list[0].id, type, event, label, time: list[i].time, ...extra });
    };
    const final = { [TENNIS_TYPE]: s => Boolean(s.winner), [TABLE_TENNIS_TYPE]: s => s.status === 'ended' && Boolean(s.winner),
      [ESPORTS_TYPE]: s => s.status === 'complete', [SOCCER_TYPE]: s => s.homeReg !== null && s.homeReg !== undefined }[type];
    if (final) first(final, 'final', e => FINAL_KINDS.has(kind(e)));
    if (type === TENNIS_TYPE) for (let n = 1; n <= 5; n++)
      first(s => ['winner', 'loser'].includes(s.sets?.[n - 1]?.[2]), `set ${n}`, e => kind(e) === 'SETWINNER' && suffix(e) === n);
    if (type === ESPORTS_TYPE) for (let n = 1; n <= 5; n++)
      first(s => (s.maps?.[n - 1] ?? []).slice(0, 2).includes(1), `map ${n}`, e => kind(e) === 'MAP' && suffix(e) === n);
    if (type === SOCCER_TYPE) for (let g = 1; g <= 10; g++)
      first(s => Number(s.home) + Number(s.away) >= g, `goal ${g}`, e => kind(e) === 'TOTAL', { goals: g });
  }
  return moments;
}

const takerFee = p => 0.07 * p * (1 - p);
// Trades of one decided market around `at`, from the winning side (result 'yes' or 'no'): the winning price last traded before
// `at`, seconds until it first traded at 99¢ or more, and the taker buys of the winning side below 99¢ after `at`, split into
// the first 30 seconds, 30 seconds to 2 minutes, and 2 to 15 minutes, with the edge after the taker fee they carried.
export function lagStats(trades, at, result) {
  const rows = trades.map(t => ({ time: Date.parse(t.created_time), price: Number(result === 'yes' ? t.yes_price_dollars : t.no_price_dollars),
    count: Number(t.count_fp) || 0, winnerTook: t.taker_side === result })).filter(t => Number.isFinite(t.time) && Number.isFinite(t.price)).sort((a, b) => a.time - b.time);
  const before = rows.filter(t => t.time <= at).at(-1)?.price ?? null, after = rows.filter(t => t.time > at);
  const hit = after.find(t => t.price >= 0.99), windows = { first30s: [0, 30], to2m: [30, 120], to15m: [120, 900] };
  const cheap = {};
  for (const [name, [from, to]] of Object.entries(windows)) {
    const inWindow = after.filter(t => t.winnerTook && t.price < 0.99 && t.time - at > from * 1000 && t.time - at <= to * 1000);
    cheap[name] = { contracts: inWindow.reduce((a, t) => a + t.count, 0), edge: inWindow.reduce((a, t) => a + t.count * (1 - t.price - takerFee(t.price)), 0) };
  }
  // Seconds from `at` to the winning side's last print under 97¢: negative means the market had moved before the log saw the result.
  const under = rows.filter(t => t.price < 0.97 && t.time - at <= 900000).at(-1);
  return { before, secondsTo99: hit ? (hit.time - at) / 1000 : null, lastUnder97: under ? (under.time - at) / 1000 : null, trades: after.length, cheap };
}
