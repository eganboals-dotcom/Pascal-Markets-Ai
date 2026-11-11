// Agent D (plan Phase 1F): weather fair value for Kalshi daily high and low temperature markets. A day-ahead NOAA-based forecast,
// corrected by each station's own earlier errors, gives the chance the official reading lands in each strike range. Research only.

// The settlement station is named in each market's rules as its NWS climate report, such as (CLINYC) for Central Park.
export const stationOf = rules => { const m = /\(CLI([A-Z]{3})\)/.exec(rules ?? ''); return m ? m[1] : null; };
export const kindOf = series => series?.startsWith('KXHIGH') ? 'high' : series?.startsWith('KXLOW') ? 'low' : null;

// Abramowitz and Stegun 7.1.26: good to about 1e-7, plenty for prices on a cent grid.
export function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Readings are whole degrees. Kalshi's strikes: between = floor to cap inclusive, greater = above floor, less = below cap.
export function strikeProbability(market, mean, sd) {
  const below = x => normalCdf((x - mean) / sd);
  if (market.strike_type === 'between') return below(market.cap_strike + 0.5) - below(market.floor_strike - 0.5);
  if (market.strike_type === 'greater') return 1 - below(market.floor_strike + 0.5);
  if (market.strike_type === 'less') return below(market.cap_strike - 0.5);
  return null;
}

// Whether a reading pays Yes under the same rules; used to check the station and strikes against Kalshi's own results.
export function paysYes(market, reading) {
  if (market.strike_type === 'between') return reading >= market.floor_strike && reading <= market.cap_strike;
  if (market.strike_type === 'greater') return reading > market.floor_strike;
  if (market.strike_type === 'less') return reading < market.cap_strike;
  return null;
}

// Daily max and min per local date from Open-Meteo hourly rows ("2026-11-04T13:00").
export function dailyExtremes(times, temps) {
  const days = {};
  times.forEach((time, i) => {
    const t = temps[i];
    if (!Number.isFinite(t)) return;
    const date = time.slice(0, 10), d = days[date] ?? { high: -Infinity, low: Infinity, hours: 0 };
    days[date] = { high: Math.max(d.high, t), low: Math.min(d.low, t), hours: d.hours + 1 };
  });
  return Object.fromEntries(Object.entries(days).filter(([, d]) => d.hours >= 20));
}

// Bias and spread of reading minus forecast over earlier days; none until enough days exist. The spread has a floor so a calm
// stretch does not make the model overconfident.
export function errorModel(residuals, { minDays = 10, minSd = 1.5 } = {}) {
  if (residuals.length < minDays) return null;
  const bias = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const sd = Math.sqrt(residuals.reduce((a, r) => a + (r - bias) ** 2, 0) / (residuals.length - 1));
  return { bias, sd: Math.max(minSd, sd), days: residuals.length };
}
