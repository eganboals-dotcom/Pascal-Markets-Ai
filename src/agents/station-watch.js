// Station-watch (weather department): the readings a station has reported so far on its climate day bound that day's official
// high and low. The high can only rise from here and the low only fall, so some of Kalshi's strike ranges are already decided
// before the report comes out. Hourly readings miss the peaks between them, which only widens the bound in the safe direction;
// the cushion covers the difference between an hourly reading and the climate report. On 230 station-days (Sept 25 to Nov 7)
// the report's high was never below the hourly maximum, while its low was above the hourly minimum on 7, by up to 4°.
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

// Iowa Environmental Mesonet ASOS rows ("NYC,2026-11-04 17:51,71.00", times in UTC) into readings.
export const asosReadings = csv => csv.split('\n').slice(1).map(line => line.trim().split(','))
  .filter(f => f.length >= 3 && f[2] !== '').map(([, valid, temp]) => ({ time: Date.parse(`${valid.replace(' ', 'T')}Z`), temp: Number(temp) }))
  .filter(r => Number.isFinite(r.time) && Number.isFinite(r.temp));
export const asosUrl = (code, start, end) => 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=' + code +
  `&data=tmpf&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&report_type=3&report_type=4&sts=${new Date(start).toISOString().slice(0, 16)}Z&ets=${new Date(end).toISOString().slice(0, 16)}Z`;
