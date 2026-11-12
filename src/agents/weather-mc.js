// Monte Carlo day model (weather department): the chance each Kalshi temperature range pays, at any moment of the day. The rest of
// the climate day is simulated many times by replaying how far the forecast missed the day's extreme on the station's own earlier
// days (an analog ensemble), moved by where the latest reading stands against the forecast. The share of simulated days a range
// pays is its fair price.
import { paysYes } from './fair-weather.js';

const HOUR_MS = 3600000, DAY_MS = 86400000, MAX_RHO = 0.995;

// Small seeded generator (mulberry32), so a history test gives the same prices every run.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = rand => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// Hourly forecast { start, temps } (temps[i] at start + i hours, UTC), interpolated between hours; NaN outside it.
export function forecastAt(forecast, time) {
  const x = (time - forecast.start) / HOUR_MS, i = Math.floor(x), a = forecast.temps[i], b = forecast.temps[i + 1];
  if (!Number.isFinite(a)) return NaN;
  return Number.isFinite(b) ? a + (b - a) * (x - i) : x === i ? a : NaN;
}

// Reading minus forecast at each whole hour in [from, to) that has a reading within 10 minutes of it. Readings sorted by time.
export function hourlyErrors(readings, forecast, from, to) {
  const out = [];
  let j = 0;
  for (let h = Math.ceil(from / HOUR_MS) * HOUR_MS; h < to; h += HOUR_MS) {
    while (j < readings.length && readings[j].time < h - 10 * 60000) j++;
    let best = null;
    for (let k = j; k < readings.length && readings[k].time <= h + 10 * 60000; k++) if (!best || Math.abs(readings[k].time - h) < Math.abs(best.time - h)) best = readings[k];
    const f = forecastAt(forecast, h);
    if (best && Number.isFinite(f)) out.push({ time: h, error: best.temp - f });
  }
  return out;
}

// Bias, hour-to-hour persistence and the hourly surprise from consecutive hourly errors; null with too few hours.
export function fitErrors(errors, { minHours = 120 } = {}) {
  if (errors.length < minHours) return null;
  const bias = errors.reduce((s, e) => s + e.error, 0) / errors.length;
  const pairs = [];
  for (let i = 1; i < errors.length; i++) if (errors[i].time - errors[i - 1].time === HOUR_MS) pairs.push([errors[i - 1].error - bias, errors[i].error - bias]);
  if (pairs.length < minHours / 2) return null;
  let xy = 0, xx = 0;
  for (const [x, y] of pairs) { xy += x * y; xx += x * x; }
  const rho = Math.min(MAX_RHO, Math.max(0, xx ? xy / xx : 0));
  const sd = Math.sqrt(pairs.reduce((s, [x, y]) => s + (y - rho * x) ** 2, 0) / pairs.length);
  return { bias, rho, sd: Math.max(sd, 0.3), hours: errors.length };
}

// One earlier day of a station: its hourly readings and forecast from 24 hours before the climate day to the day's end (48 slots,
// NaN where missing), and the gaps from its extremes to the climate report, once against all readings and once against the
// hourly ones. null when the report is missing or fewer than 40 hours have readings.
export function trainingDay(readings, forecast, dayStart, report) {
  const reads = new Array(48).fill(NaN), fc = new Array(48).fill(NaN), day = { high: -Infinity, low: Infinity }, hourly = { high: -Infinity, low: Infinity };
  for (let i = 0; i < 48; i++) fc[i] = forecastAt(forecast, dayStart + (i - 24) * HOUR_MS);
  for (const e of hourlyErrors(readings, forecast, dayStart - DAY_MS, dayStart + DAY_MS)) {
    const i = Math.round((e.time - dayStart) / HOUR_MS) + 24;
    reads[i] = e.error + fc[i];
    if (i >= 24) { hourly.high = Math.max(hourly.high, reads[i]); hourly.low = Math.min(hourly.low, reads[i]); }
  }
  for (const r of readings) if (r.time >= dayStart && r.time < dayStart + DAY_MS) { day.high = Math.max(day.high, r.temp); day.low = Math.min(day.low, r.temp); }
  if (reads.filter(Number.isFinite).length < 40 || ![report?.high, report?.low, day.high, day.low, hourly.high, hourly.low].every(Number.isFinite)) return null;
  return { reads, fc, gapAll: { high: report.high - day.high, low: report.low - day.low }, gapHourly: { high: report.high - hourly.high, low: report.low - hourly.low } };
}

// Simulated official readings for one climate day [dayStart, dayStart + 24 h). Each simulated day takes one earlier day and its
// miss on the extreme of the hours still left: that day's highest hourly reading over those hours minus its forecast's highest
// over the same hours (for lows, the lowest). Today's forecast extreme over those hours plus that miss gives the hours left; the
// latest reading's error e0 at `from` shifts it, fading by rho an hour until the forecast extreme. The report is the larger (for
// lows the smaller) of the readings so far plus that day's all-readings gap and the hours left plus its hourly gap, rounded.
// Missing the extreme rather than replaying the whole hourly path keeps the simulated day from spreading wider than real days do.
export function simulateDay({ kind, soFar = null, from, e0 = null, dayStart, forecast, days, rho, sims = 500, jitter = 0.5, seed = 1 }) {
  const rand = rng(seed), high = kind === 'high', pick = high ? Math.max : Math.min, out = [];
  const firstHour = Math.max(0, Math.ceil((from - dayStart) / HOUR_MS)), anchor = Math.min(47, Math.max(0, Math.round((from - dayStart) / HOUR_MS) + 24));
  let today = high ? -Infinity : Infinity, at = null;
  for (let h = firstHour; h < 24; h++) {
    const f = forecastAt(forecast, dayStart + h * HOUR_MS);
    if (Number.isFinite(f) && (high ? f > today : f < today)) { today = f; at = dayStart + h * HOUR_MS; }
  }
  for (let s = 0; s < sims && days.length; s++) {
    const d = days[Math.floor(rand() * days.length)], noise = jitter * normal(rand);
    let read = high ? -Infinity : Infinity, fc = read;
    for (let i = firstHour + 24; i < 48; i++) {
      if (Number.isFinite(d.reads[i])) read = pick(read, d.reads[i]);
      if (Number.isFinite(d.fc[i])) fc = pick(fc, d.fc[i]);
    }
    let base = NaN;
    for (let i = anchor; i >= 0 && !Number.isFinite(base); i--) base = d.reads[i] - d.fc[i];
    const shift = e0 === null || !Number.isFinite(base) || at === null ? 0 : (e0 - base) * rho ** (Math.max(0, at - from) / HOUR_MS);
    const left = today + (read - fc) + shift + noise;
    const options = [soFar === null ? NaN : soFar + d.gapAll[kind], left + d.gapHourly[kind]].filter(Number.isFinite);
    if (options.length) out.push(Math.round(pick(...options)));
  }
  return out;
}

// Share of simulated readings that pay Yes on a strike, or null without simulations.
export const fairPrice = (strike, readings) => readings.length ? readings.filter(r => paysYes(strike, r)).length / readings.length : null;
