// Logs sportsbook lines for the sports Kalshi lists, for the sportsbook agents (plan Phase 1S). Research only; no bets, no orders.
// ESPN (DraftKings) every --minutes (default 5), free. With ODDS_API_KEY set, the top books below through The Odds API, spent
// only where it counts: a league is swept when one of its games starts within --books-lead minutes (default 60), at most once per
// --books-spacing minutes (default 120), and never past --books-daily credits a UTC day (default 15; 15 x 30 fits the free plan's
// 500 a month). Each market type in --books-markets costs one credit per league sweep. Never calls Kalshi, so it does not compete
// with the history download. Writes data/odds/<UTC day>.jsonl. --once runs one sweep and exits.
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dueLeagues, espnRows, fetchJson, oddsApiRows } from '../src/odds.js';
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
const CREDIT_FLOOR = 20;

const text = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const arg = (name, fallback) => Number(text(name, fallback));
const minutes = arg('minutes', 5), once = process.argv.includes('--once');
const lead = arg('books-lead', 60) * 60000, spacing = arg('books-spacing', 120) * 60000, dailyCap = arg('books-daily', 15);
const booksMarkets = text('books-markets', 'h2h');
if (!/^[a-z0-9_]+(,[a-z0-9_]+)*$/.test(booksMarkets)) throw new Error('--books-markets takes a comma list such as h2h,spreads,totals');
const cost = booksMarkets.split(',').length;
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
const starts = new Map(); // league -> start times of its games not yet started, from the latest ESPN sweep

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
    starts.set(league, [...new Set(rows.filter(r => r.state === 'pre').map(r => Date.parse(r.start)))]);
  }
  say({ source: 'espn', rows: count });
}

let booksOn = Boolean(key), spent = { day: '', credits: 0 };
const lastSwept = new Map();
async function booksSweep() {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  if (spent.day !== day) spent = { day, credits: 0 };
  for (const league of dueLeagues(starts, lastSwept, now, lead, spacing)) {
    if (spent.credits + cost > dailyCap) { say({ source: 'the-odds-api', skipped: league, reason: `daily cap of ${dailyCap} credits reached` }); continue; }
    const sport = LEAGUES.find(l => l[0] === league)[2];
    lastSwept.set(league, now);
    try {
      const { json, headers } = await fetchJson(`https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${encodeURIComponent(key)}` +
        `&bookmakers=${BOOKS}&markets=${booksMarkets}&oddsFormat=american&dateFormat=iso`, `Odds API ${league}`);
      spent = { ...spent, credits: spent.credits + cost };
      const rows = oddsApiRows(json, league, Date.now()), remaining = Number(headers.get('x-requests-remaining'));
      write(rows);
      say({ source: 'the-odds-api', league, rows: rows.length, games: json.length, creditsToday: spent.credits, creditsLeft: remaining });
      if (remaining < CREDIT_FLOOR) { booksOn = false; warn({ source: 'the-odds-api', stopped: `fewer than ${CREDIT_FLOOR} credits left` }); return; }
    } catch (error) { warn({ source: 'the-odds-api', league, error: error.message }); }
  }
}

say({ started: true, espnMinutes: minutes, books: booksOn ? BOOKS : 'off (no ODDS_API_KEY)', booksMarkets, leadMinutes: lead / 60000, dailyCap });
for (;;) {
  await espnSweep();
  if (booksOn) await booksSweep();
  if (once) break;
  await sleep(minutes * 60000);
}
