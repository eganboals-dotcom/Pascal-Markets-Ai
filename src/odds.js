// Sportsbook lines in one row shape for both sources: ESPN's free scoreboard (DraftKings only) and The Odds API (every top
// US book plus Pinnacle; needs the user's own ODDS_API_KEY). Raw American odds are kept; removing the margin is the agents' job.
const american = v => v == null || v === '' ? null : /^even$/i.test(String(v)) ? 100 : Number(v);
const line = v => v == null || v === '' ? null : Number(String(v).replace(/^[ou]/i, ''));

export function espnRows(scoreboard, league, time) {
  const rows = [];
  for (const event of scoreboard?.events ?? []) {
    const competition = event.competitions?.[0], odds = competition?.odds?.[0], state = event.status?.type?.state;
    if (!odds || state === 'post') continue;
    const team = side => competition.competitors?.find(c => c.homeAway === side)?.team ?? {};
    const home = team('home'), away = team('away');
    const base = { time, source: 'espn', book: odds.provider?.name ?? 'unknown', league, eventId: event.id, start: event.date, state,
      home: home.displayName, away: away.displayName, homeCode: home.abbreviation, awayCode: away.abbreviation };
    const add = (market, sides) => {
      const outcomes = sides.map(([name, quote]) => ({ name, price: american(quote?.close?.odds), point: line(quote?.close?.line) }));
      if (outcomes.every(o => Number.isFinite(o.price))) rows.push({ ...base, market, outcomes });
    };
    add('h2h', [[home.displayName, odds.moneyline?.home], [away.displayName, odds.moneyline?.away]]);
    add('spreads', [[home.displayName, odds.pointSpread?.home], [away.displayName, odds.pointSpread?.away]]);
    add('totals', [['Over', odds.total?.over], ['Under', odds.total?.under]]);
  }
  return rows;
}

export function oddsApiRows(events, league, time) {
  return (events ?? []).flatMap(event => (event.bookmakers ?? []).flatMap(book => (book.markets ?? []).map(market => ({
    time, source: 'the-odds-api', book: book.key, league, eventId: event.id, start: event.commence_time,
    state: Date.parse(event.commence_time) > time ? 'pre' : 'in', home: event.home_team, away: event.away_team,
    market: market.key, updated: market.last_update,
    outcomes: (market.outcomes ?? []).map(o => ({ name: o.name, price: o.price, point: o.point ?? null })),
  }))));
}

// Errors carry only the label and status: Odds API URLs hold the key.
export async function fetchJson(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return { json: await response.json(), headers: response.headers };
}
