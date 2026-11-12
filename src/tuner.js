// Walk-forward choice of one setting per market group by profit-to-risk (research only). Trades are { day, group, setting, ticker,
// event?, pnl, stake }: one row per market a setting would have traded, stake being price plus fee. The event defaults to the
// ticker's event part; game-watch passes the game, so one game's props count together. Profit-to-risk is the low end of the
// profit range (resampling whole events) divided by the money staked, so a setting that made a lot on few events, or whose worst
// event wipes out the rest, scores low. Each day is traded with the setting that scored best on the days before it, per group; a
// group whose best score is not above zero, or that has fewer than minEvents earlier events, is not traded that day.
import { bootstrapTotal } from './stats.js';
import { GATE_RANGE } from './takers.js';

const Z_LOW = 2.24; // the 1.25% tail of a normal: the GATE_RANGE low end, for the many choices made along the walk

// Profit-to-risk of a set of trades. `quick` uses a normal approximation of the event-resampled low end (the walk makes thousands
// of these choices); the reported scores use the resampling itself.
export function profitToRisk(trades, { quick = false } = {}) {
  const sums = new Map();
  for (const t of trades) { const e = t.event ?? t.ticker.slice(0, t.ticker.lastIndexOf('-')); sums.set(e, (sums.get(e) ?? 0) + t.pnl); }
  const byEvent = [...sums.values()], stake = trades.reduce((a, t) => a + t.stake, 0);
  const total = byEvent.reduce((a, b) => a + b, 0), n = byEvent.length;
  if (!n || !(stake > 0)) return { trades: trades.length, events: n, pnl: total, low: 0, stake, score: 0, worstEvent: 0 };
  let low;
  if (quick) {
    const mean = total / n, variance = byEvent.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1);
    low = total - Z_LOW * Math.sqrt(n * variance);
  } else low = bootstrapTotal(byEvent, GATE_RANGE).low;
  return { trades: trades.length, events: n, pnl: total, low, stake, score: low / stake, worstEvent: Math.min(...byEvent) };
}

// The best setting for one group's earlier trades, or null when none scores above zero on at least minEvents events. The best is
// the highest profit-to-risk, or with objective 'low' the highest low end of the profit range in dollars (more trades at a thinner
// return can beat fewer at a fatter one).
export function bestSetting(trades, { minEvents = 10, quick = true, objective = 'ratio' } = {}) {
  const rank = s => (objective === 'low' ? s.low : s.score);
  const bySetting = new Map();
  for (const t of trades) bySetting.set(t.setting, [...(bySetting.get(t.setting) ?? []), t]);
  let best = null;
  for (const [setting, list] of bySetting) {
    const s = profitToRisk(list, { quick });
    if (s.events >= minEvents && s.score > 0 && (!best || rank(s) > rank(best))) best = { setting, ...s };
  }
  return best;
}

// Walks the days in order. Returns the trades taken (each day by the settings chosen from earlier days), every day's choices, and
// the choices for the day after the last one (what a live agent would run next), scored on all days.
export function walkForward(trades, options = {}) {
  const days = [...new Set(trades.map(t => t.day))].sort(), groups = [...new Set(trades.map(t => t.group))].sort();
  const byGroup = new Map(groups.map(g => [g, trades.filter(t => t.group === g)])), taken = [], choices = [];
  for (const day of days) {
    for (const group of groups) {
      const pick = bestSetting(byGroup.get(group).filter(t => t.day < day), options);
      choices.push({ day, group, setting: pick?.setting ?? null });
      if (pick) taken.push(...byGroup.get(group).filter(t => t.day === day && t.setting === pick.setting));
    }
  }
  const next = Object.fromEntries(groups.map(g => [g, bestSetting(byGroup.get(g), { ...options, quick: false })]));
  return { days, taken, choices, next };
}

// The live agents' side: the margin a group should run from the picker's report (scripts/agent-tune.js), the fallback when the
// history has too few events to say (or no report exists), or null for a group the history switched off.
export const TUNE_REPORT = 'data/history/agents/tune-report.json';
export function pickedMargin(report, agent, group, fallback) {
  const next = report?.agents?.[agent]?.next?.[group];
  if (!next || next.pick === 'default') return fallback;
  return next.pick === 'off' ? null : next.pick;
}

// The live agents follow a group's pick (a setting or "off") only where the walk made more in dollars than the fixed default on
// the same days (all but the first, which the walk cannot trade); elsewhere the group runs the default. "default" picks pass as is.
export function guardPicks(next, walk, trades, fixed) {
  const sum = list => list.reduce((a, t) => a + t.pnl, 0);
  return Object.fromEntries(Object.entries(next).map(([group, n]) => {
    if (n.pick === 'default' || n.pick === fixed) return [group, n];
    const picker = sum(walk.taken.filter(t => t.group === group));
    const plain = sum(trades.filter(t => t.group === group && t.setting === fixed && t.day > walk.days[0]));
    return [group, picker > plain ? n : { pick: fixed, events: n.events, guarded: true, picker, fixed: plain }];
  }));
}
