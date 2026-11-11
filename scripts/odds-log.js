// Logs sportsbook lines for the sports Kalshi lists, for the sportsbook agents (plan Phase 1S). Research only; no bets, no orders.
// ESPN (DraftKings) every --minutes (default 5). With ODDS_API_KEY set, the top books below through The Odds API every
// --books-minutes (default 60; about 3 credits per in-season sport per sweep). Never calls Kalshi, so it does not compete with
// the history download. Writes data/odds/<UTC day>.jsonl. --once runs one sweep and exits.
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { espnRows, fetchJson, oddsApiRows } from '../src/odds.js';
import { projectPath } from '../src/files.js';

const LEAGUES = [ // [name, ESPN path and query, Odds API sport key]
  ['nfl', 'football/nfl', 'americanfootball_nfl'],
  ['ncaaf', 'football/college-football?groups=80&limit=500', 'americanfootball_ncaaf'],
  ['nba', 'basketball/nba', 'basketball_nba'],
  ['ncaab', 'basketball/mens-college-basketball?groups=50&limit=500', 'basketball_ncaab'],
  ['nhl', 'hockey/nhl', 'icehockey_nhl'],
  ['mlb', 'baseball/mlb', 'baseball_mlb'],
  ['wnba', 'basketball/wnba', 'basketball_wnba'],
];
// Ten books count as one region in The Odds API's billing; Pinnacle is the sharpest reference line.
const BOOKS = 'pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,bovada,betonlineag';
const CREDIT_FLOOR = 100;

const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const minutes = arg('minutes', 5), booksMinutes = arg('books-minutes', 60), once = process.argv.includes('--once');
const key = process.env.ODDS_API_KEY;
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const warn = fields => console.error(JSON.stringify({ time: new Date().toISOString(), ...fields }));
mkdirSync(projectPath('data/odds'), { recursive: true });

function write(rows) {
  if (!rows.length) return;
  const file = projectPath(`data/odds/${new Date(rows[0].time).toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ESPN's default view is today (the current week for football) and date ranges come back empty, so the next two US dates are
// asked for one by one; books post lines about a day ahead.
const usDate = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');

async function espnSweep() {
  let count = 0;
  for (const [league, path] of LEAGUES) {
    const [route, query = ''] = path.split('?'), events = new Map();
    for (const dates of ['', usDate(1), usDate(2)]) {
      const params = [query, dates && `dates=${dates}`].filter(Boolean).join('&');
      try {
        const { json } = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${route}/scoreboard${params && `?${params}`}`, `ESPN ${league}`);
        for (const event of json.events ?? []) events.set(event.id, event);
      } catch (error) { warn({ source: 'espn', league, dates, error: error.message }); }
    }
    const rows = espnRows({ events: [...events.values()] }, league, Date.now());
    write(rows);
    count += rows.length;
  }
  say({ source: 'espn', rows: count });
}

let booksOn = Boolean(key);
async function booksSweep() {
  const base = 'https://api.the-odds-api.com/v4/sports';
  try {
    const { json: sports } = await fetchJson(`${base}/?apiKey=${encodeURIComponent(key)}`, 'Odds API sports'); // free call
    const active = new Set(sports.filter(s => s.active).map(s => s.key));
    let count = 0, remaining = null;
    for (const [league, , sport] of LEAGUES.filter(l => active.has(l[2]))) {
      const { json, headers } = await fetchJson(`${base}/${sport}/odds/?apiKey=${encodeURIComponent(key)}&bookmakers=${BOOKS}` +
        '&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso', `Odds API ${league}`);
      const rows = oddsApiRows(json, league, Date.now());
      write(rows);
      count += rows.length;
      remaining = Number(headers.get('x-requests-remaining'));
      if (remaining < CREDIT_FLOOR) { booksOn = false; warn({ source: 'the-odds-api', stopped: `fewer than ${CREDIT_FLOOR} credits left` }); break; }
    }
    say({ source: 'the-odds-api', rows: count, creditsLeft: remaining });
  } catch (error) { warn({ source: 'the-odds-api', error: error.message }); }
}

say({ started: true, espnMinutes: minutes, books: booksOn ? BOOKS : 'off (no ODDS_API_KEY)', booksMinutes });
let nextEspn = 0, nextBooks = 0;
for (;;) {
  if (Date.now() >= nextEspn) { await espnSweep(); nextEspn = Date.now() + minutes * 60000; }
  if (booksOn && Date.now() >= nextBooks) { await booksSweep(); nextBooks = Date.now() + booksMinutes * 60000; }
  if (once) break;
  await sleep(Math.max(1000, Math.min(nextEspn, booksOn ? nextBooks : Infinity) - Date.now()));
}
