import { fairOdds } from './odds.js';

export async function fetchNbaOdds({ apiKey = process.env.ODDS_API_KEY, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set ODDS_API_KEY to use the sportsbook snapshot command');
  const url = new URL('https://api.the-odds-api.com/v4/sports/basketball_nba/odds');
  url.search = new URLSearchParams({ apiKey, regions: 'us', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' });
  const requestedAt = Date.now();
  let response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('Sportsbook request failed; request URL and credentials withheld'); }
  if (!response.ok) throw new Error(`Sportsbook HTTP ${response.status}`);
  const events = await response.json();
  if (!Array.isArray(events)) throw new Error('Unexpected sportsbook response');
  return {
    source: 'the-odds-api', requestedAt, receivedAt: Date.now(),
    remainingCredits: response.headers.get('x-requests-remaining'),
    requestCost: response.headers.get('x-requests-last'), events
  };
}

export function normalizeSportsbook(snapshot, mapping) {
  const event = snapshot.events.find(event => event.id === mapping.providerGameId);
  if (!event || event.sport_key !== 'basketball_nba' || event.home_team !== mapping.homeTeam ||
      event.away_team !== mapping.awayTeam || Date.parse(event.commence_time) !== mapping.startsAt) {
    throw new Error('Sportsbook event does not match the configured game, teams, and start time');
  }
  const bookmaker = event.bookmakers?.find(bookmaker => bookmaker.key === mapping.bookmaker);
  const market = bookmaker?.markets?.find(market => market.key === 'h2h');
  if (market?.outcomes?.length !== 2) throw new Error('A complete two-outcome moneyline is required');
  const homeOdds = market.outcomes.find(outcome => outcome.name === event.home_team)?.price;
  const awayOdds = market.outcomes.find(outcome => outcome.name === event.away_team)?.price;
  const probabilities = fairOdds(homeOdds, awayOdds);
  const sourceAt = Date.parse(market.last_update ?? bookmaker.last_update);
  if (!Number.isFinite(sourceAt) || !Number.isFinite(snapshot.receivedAt)) throw new Error('Missing sportsbook timestamp');
  return {
    gameId: mapping.gameId, providerGameId: event.id, bookmaker: bookmaker.key,
    sourceAt, receivedAt: snapshot.receivedAt, homeOdds, awayOdds, format: 'decimal',
    marketType: 'moneyline', includesOvertime: mapping.includesOvertime === true,
    // This provider does not guarantee an explicit market suspension flag.
    suspended: typeof market.suspended === 'boolean' ? market.suspended : null,
    timestampBasis: market.last_update ? 'market' : 'bookmaker', ...probabilities
  };
}
