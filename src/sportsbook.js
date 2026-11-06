import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fairOdds } from './odds.js';
import { projectPath } from './files.js';

export async function fetchNbaOdds({ apiKey = process.env.ODDS_API_KEY, fetchImpl = fetch, signal } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Set ODDS_API_KEY to use the sportsbook snapshot command');
  const url = new URL('https://api.the-odds-api.com/v4/sports/basketball_nba/odds');
  url.search = new URLSearchParams({ apiKey, regions: 'us', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' });
  const requestedAt = Date.now();
  let response;
  const timeout = AbortSignal.timeout(15000);
  try { response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch { throw new Error('Sportsbook request failed; request URL and credentials withheld'); }
  if (!response.ok) throw new Error(`Sportsbook HTTP ${response.status}`);
  let events;
  try { events = await response.json(); }
  catch { throw new Error('Invalid sportsbook response'); }
  if (!Array.isArray(events)) throw new Error('Unexpected sportsbook response');
  return {
    source: 'the-odds-api', requestedAt, receivedAt: Date.now(),
    remainingCredits: response.headers.get('x-requests-remaining'),
    requestCost: response.headers.get('x-requests-last'), events
  };
}

function sameTeam(catalogName, providerName) {
  if (typeof catalogName !== 'string' || typeof providerName !== 'string') return false;
  const shortName = catalogName.toLowerCase().trim();
  const fullName = providerName.toLowerCase().trim();
  return shortName.length > 0 && (fullName === shortName || fullName.endsWith(` ${shortName}`));
}

export function reviewedMarket(markets, mapping) {
  const market = markets.find(market => market.marketId === mapping.marketId && market.gameId === mapping.gameId);
  if (!market || mapping.rulesHash !== market.rulesHash || mapping.startsAt !== market.startsAt ||
      mapping.reviewed !== true || mapping.includesOvertime !== true || market.includesOvertime !== true ||
      !sameTeam(market.homeTeam, mapping.homeTeam) || !sameTeam(market.awayTeam, mapping.awayTeam)) return null;
  return market;
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

export async function recordSportsbook(path, mapping, maxRequests, signal, fetchSnapshot = fetchNbaOdds) {
  const output = projectPath(path);
  const report = { requests: 0, quotes: 0, unavailable: 0 };
  const identity = { gameId: mapping.gameId, marketId: mapping.marketId, rulesHash: mapping.rulesHash };
  while (!signal.aborted && report.requests < maxRequests) {
    report.requests++;
    let snapshot;
    try { snapshot = await fetchSnapshot({ signal }); }
    catch {
      if (signal.aborted) break;
      appendFileSync(output, JSON.stringify({ ...identity, receivedAt: Date.now(), suspended: null }) + '\n');
      report.unavailable++;
      report.stopped = 'provider-request-failed';
      break;
    }
    if (signal.aborted) break;
    let quote;
    try { quote = normalizeSportsbook(snapshot, mapping); }
    catch { quote = { receivedAt: snapshot.receivedAt, suspended: null }; }
    appendFileSync(output, JSON.stringify({ ...quote, ...identity }) + '\n');
    if (Number.isFinite(quote.sourceAt)) report.quotes++;
    else report.unavailable++;
    if (snapshot.remainingCredits === '0') { report.stopped = 'provider-quota-exhausted'; break; }
    if (report.requests >= maxRequests) break;
    try { await sleep(40000, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
  return report;
}
