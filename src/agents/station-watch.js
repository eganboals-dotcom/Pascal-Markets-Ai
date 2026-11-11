// Station-watch (weather department): the readings a station has reported so far on its climate day bound that day's official
// high and low. The high can only rise from here and the low only fall, so some of Kalshi's strike ranges are already decided
// before the report comes out. Most stations send a reading every 5 minutes, in whole degrees Celsius (up to 0.9°F off), and an
// hourly one in tenths; Central Park sends hourly only. The cushion covers the difference from the climate report: on 1,027
// station-days (Sept 21 to Nov 1, all 24 stations) the report's high was never more than 1° below the highest reading, and its
// low was more than 2° above the lowest reading once (Miami, Sept 28: steady 75°F readings for over an hour, report says 80).
export const CUSHION = { high: 1, low: 2 };

// NWS climate days run midnight to midnight local standard time all year, so the offset is January's.
export function standardOffsetMs(tz) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(Date.UTC(2026, 0, 15))).find(p => p.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
}
export const climateDate = (time, offsetMs) => new Date(time + offsetMs).toISOString().slice(0, 10);
export const climateDayStart = (date, offsetMs) => Date.parse(date) - offsetMs;

// Highest and lowest reading on that climate day up to a moment, or null before the first one. Readings are { time, temp }.
export function soFar(readings, date, offsetMs, until = Infinity) {
  let high = -Infinity, low = Infinity, count = 0;
  for (const r of readings) {
    if (r.time > until || !Number.isFinite(r.temp) || climateDate(r.time, offsetMs) !== date) continue;
    high = Math.max(high, r.temp); low = Math.min(low, r.temp); count++;
  }
  return count ? { high, low, count } : null;
}

// 'yes' or 'no' once the readings so far settle a strike range whatever the rest of the day does, else null. Strikes follow
// Agent D's reading of Kalshi's rules: between = floor to cap inclusive, greater = above floor, less = below cap.
export function decided(strike, kind, bound, cushion = CUSHION) {
  if (!bound) return null;
  const { strike_type: type, floor_strike: floor, cap_strike: cap } = strike;
  if (kind === 'high') {
    const least = Math.ceil(bound.high - cushion.high); // the official high is at least this
    if (type === 'between') return cap < least ? 'no' : null;
    if (type === 'greater') return least > floor ? 'yes' : null;
    if (type === 'less') return least >= cap ? 'no' : null;
  }
  if (kind === 'low') {
    const most = Math.floor(bound.low + cushion.low); // the official low is at most this
    if (type === 'between') return floor > most ? 'no' : null;
    if (type === 'less') return most < cap ? 'yes' : null;
    if (type === 'greater') return most <= floor ? 'no' : null;
  }
  return null;
}

// The METAR's T group, tenths of a degree Celsius ("T01900050" is 19.0°C), in °F; NaN without one.
export const tGroupF = metar => { const m = / T([01])(\d{3})/.exec(metar ?? ''); return m ? (m[1] === '1' ? -1 : 1) * Number(m[2]) / 10 * 9 / 5 + 32 : NaN; };

// Iowa Environmental Mesonet ASOS rows (station,valid,tmpf,metar; times in UTC) into readings. The 5-minute reports leave tmpf
// empty but carry the T group, which is also finer than the hourly tmpf; tmpf is the fallback. A row with neither is dropped,
// since a whole-degree Celsius reading can sit almost a degree Fahrenheit from the truth.
export function asosReadings(csv) {
  const [head = '', ...lines] = csv.split('\n'), cols = head.trim().split(','), at = name => cols.indexOf(name);
  return lines.map(line => line.trim().split(',')).filter(f => f.length >= 3).map(f => {
    const fine = tGroupF(f[at('metar')]);
    return { time: Date.parse(`${f[at('valid')]?.replace(' ', 'T')}Z`), temp: Number.isFinite(fine) ? Math.round(fine * 100) / 100 : f[at('tmpf')] ? Number(f[at('tmpf')]) : NaN };
  }).filter(r => Number.isFinite(r.time) && r.temp >= MIN_F && r.temp <= MAX_F).sort((a, b) => a.time - b.time).filter(nearNeighbor);
}
// Sensors sometimes send one wild value (-61°C is a common error code). A reading with others within 2 hours counts only when one
// of them is within 10°F, so the newest one waits for the next to confirm a jump; a reading after a long gap stands.
const SPIKE_F = 10, NEIGHBOR_MS = 2 * 3600000, MIN_F = -60, MAX_F = 135; // outside US station records: an error code
function nearNeighbor(r, i, all) {
  let others = 0;
  for (const step of [-1, 1]) {
    for (let j = i + step; all[j] && Math.abs(all[j].time - r.time) <= NEIGHBOR_MS; j += step) {
      if (Math.abs(all[j].temp - r.temp) <= SPIKE_F) return true;
      others++;
    }
  }
  return others === 0;
}
// Routine and special reports plus the 5-minute ones (report_type 1) where a station sends them; Central Park sends hourly only.
export const asosUrl = (code, start, end) => 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=' + code +
  `&data=tmpf&data=metar&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&report_type=1&report_type=3&report_type=4&sts=${new Date(start).toISOString().slice(0, 16)}Z&ets=${new Date(end).toISOString().slice(0, 16)}Z`;
