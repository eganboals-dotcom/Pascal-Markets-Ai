export function decimalOdds(value, format = 'decimal') {
  if (!Number.isFinite(value)) throw new Error('Odds must be finite');
  if (format === 'american') {
    if (Math.abs(value) < 100) throw new Error('Invalid American odds');
    return value > 0 ? 1 + value / 100 : 1 + 100 / -value;
  }
  if (format !== 'decimal' || value <= 1) throw new Error('Invalid decimal odds');
  return value;
}

export function sportsbookSignal(quote, now, maxAgeMs) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 ||
      !Number.isFinite(quote.sourceAt) || !Number.isFinite(quote.receivedAt) ||
      quote.sourceAt > quote.receivedAt || quote.receivedAt > now || now - quote.sourceAt > maxAgeMs ||
      quote.marketType !== 'moneyline' || quote.includesOvertime !== true || quote.suspended !== false) {
    throw new Error('Sportsbook quote is stale, suspended, incompatible, or has invalid timestamps');
  }
  return { ...fairOdds(quote.homeOdds, quote.awayOdds, quote.format),
    transportLatencyMs: quote.receivedAt - quote.sourceAt };
}

export function fairOdds(homeOdds, awayOdds, format = 'decimal') {
  const home = 1 / decimalOdds(homeOdds, format);
  const away = 1 / decimalOdds(awayOdds, format);
  return { homeProbability: home / (home + away), overround: home + away - 1 };
}
