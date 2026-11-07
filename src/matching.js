// Conservative research matches; unrecognized names or settlement wording fail closed.
import { mapConcurrent } from './dryrun.js';
const normalize = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const namesMatch = (a, b) => normalize(a) === normalize(b);
const draw = name => /^(tie|draw)$/i.test(name);
export const gameEvent = event => event.product_metadata?.competition_scope === 'Game' &&
  (/GAME$/.test(event.series_ticker) || ['KXUFCFIGHT', 'KXBOXING'].includes(event.series_ticker));

export function teamNames(event, teams = []) {
  return (event.markets ?? []).map(m => {
    const code = m.ticker?.split('-').at(-1).toLowerCase();
    const matches = teams.filter(t => t.abbreviation?.toLowerCase() === code);
    const team = matches.length === 1 ? matches[0] : null;
    return { market: m, names: [...new Set([m.yes_sub_title, team?.name, team?.alias].filter(Boolean))] };
  });
}

function timing(text) {
  const s = normalize(text);
  if (/90 minutes|regulation (?:time )?only|excluding overtime|does not include (?:extra time|overtime)|not including (?:extra time|overtime)/.test(s)) return 'regulation';
  if (/(?:including|includes|include|after|with)(?: any| all)? (?:overtime|extra time)/.test(s)) return 'overtime';
  return null;
}

// How a market settles if the game is cancelled or postponed: 'yes', 'no', 'half', or null (unstated or a
// "fair price" set later). A pair is only safe when both venues settle a called-off game the same fixed way.
export function cancellation(text) {
  const sentences = text.toLowerCase().split(/\.(?:\s|$)|\n/).filter(s => /cancel|postpone|does not start|reschedul/.test(s));
  if (!sentences.length || sentences.some(s => /fair price/.test(s))) return null;
  const outcomes = new Set(sentences.map(s => /0\.50|50[ -]50|50%|half/.test(s) ? 'half' :
    /resolves? (?:to )?"?yes/.test(s) ? 'yes' : /resolves? (?:to )?"?no\b/.test(s) ? 'no' : null));
  return outcomes.size === 1 ? [...outcomes][0] : null;
}

// Default full-game NBA/NFL periods include overtime in the linked Kalshi contract terms.

export function rulesAgree(event, market, poly) {
  const k = `${market.rules_primary ?? ''} ${market.rules_secondary ?? ''}`;
  const p = poly.description ?? '';
  if (!k.trim() || !p.trim()) return false;
  // A Polymarket draw market that resolves Yes on cancellation against a Kalshi "fair price" lost most of a basket's stake.
  const called = cancellation(k);
  if (called === null || called !== cancellation(p)) return false;
  if (['KXUFCFIGHT', 'KXBOXING'].includes(event.series_ticker)) {
    const handling = text => {
      const sentences = text.toLowerCase().split(/\.(?:\s|$)|\n/).filter(s => /draw|no[ -]contest/.test(s));
      if (!sentences.some(s => /draw/.test(s)) || !sentences.some(s => /no[ -]contest/.test(s))) return null;
      return sentences.every(s => /0\.50|50[ -]50|50%|half/.test(s)) ? 'half' : null;
    };
    // shortcut: fight matching recognizes only explicit half payouts, extend after reviewing other draw/no-contest rules.
    return handling(k) === 'half' && handling(p) === 'half';
  }
  const kt = timing(k) ?? (['KXNBAGAME', 'KXNFLGAME'].includes(event.series_ticker) ? 'overtime' : null);
  const pt = timing(p);
  return kt !== null && kt === pt;
}

export function matchGame(event, polyEvent, teams = []) {
  const participants = teamNames(event, teams);
  const competitors = participants.filter(t => !t.names.some(draw));
  if (competitors.length !== 2) return [];
  const title = ` ${normalize(polyEvent.title)} `;
  if (!competitors.every(t => t.names.some(n => title.includes(` ${normalize(n)} `)))) return [];
  const pairs = [];
  for (const { market, names } of participants) {
    const day = Math.floor(Date.parse(market.expected_expiration_time || market.close_time) / 86400000);
    for (const pm of polyEvent.markets ?? []) {
      if (pm.closed || pm.sportsMarketType !== 'moneyline') continue;
      const polyDay = Math.floor(Date.parse(pm.gameStartTime || polyEvent.startTime || polyEvent.eventDate) / 86400000);
      if (!Number.isFinite(day) || !Number.isFinite(polyDay) || Math.abs(day - polyDay) > 1 || !rulesAgree(event, market, pm)) continue;
      const outcomes = typeof pm.outcomes === 'string' ? JSON.parse(pm.outcomes) : pm.outcomes;
      if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;
      let index = outcomes.findIndex(o => names.some(n => namesMatch(n, o) || (draw(n) && draw(o))));
      if (index < 0 && outcomes.some(o => namesMatch(o, 'Yes'))) {
        const label = pm.groupItemTitle || pm.question;
        const labelText = ` ${normalize(label)} `;
        if (names.some(n => draw(n) ? /\b(draw|tie)\b/.test(labelText) :
          pm.groupItemTitle ? namesMatch(n, label) : labelText.includes(` ${normalize(n)} win `) || labelText.includes(` ${normalize(n)} to win `)) &&
            !/spread|total|handicap|both teams/.test(labelText)) index = outcomes.findIndex(o => namesMatch(o, 'Yes'));
      }
      if (index < 0) continue;
      pairs.push({ kalshiTicker: market.ticker, polymarketMarketId: String(pm.id), polymarketOutcome: index,
        autoMatched: true, reviewed: false, event, kalshiMarket: market, polymarketMarket: pm });
    }
  }
  return pairs;
}

export async function autoMatch(events, lookup) {
  const pairs = [], errors = [], teams = new Map(), searches = new Map();
  await mapConcurrent(events.filter(gameEvent), 8, async event => {
    try {
      const league = event.series_ticker.replace(/^KX/, '').replace(/GAME$|FIGHT$/, '').toLowerCase();
      if (!teams.has(league)) teams.set(league, lookup.teams(league));
      const roster = await teams.get(league);
      const participants = teamNames(event, roster).filter(t => !t.names.some(draw));
      if (participants.length !== 2) return;
      const search = participants[0].names.at(-1);
      if (!search) return;
      if (!searches.has(search)) searches.set(search, lookup.events(search));
      for (const pe of await searches.get(search)) pairs.push(...matchGame(event, pe, roster));
    } catch (error) {
      errors.push({ pair: event.event_ticker, error: error.message });
    }
  });
  const counts = new Map();
  for (const pair of pairs) counts.set(pair.kalshiTicker, (counts.get(pair.kalshiTicker) ?? 0) + 1);
  return { pairs: pairs.filter(pair => counts.get(pair.kalshiTicker) === 1), errors };
}
