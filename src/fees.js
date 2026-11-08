export function takerFeePerShare(price, schedule) {
  if (!Number.isFinite(price) || price < 0 || price > 1 ||
      !Number.isFinite(schedule?.rate) || schedule.rate < 0 || schedule.rate > 1 || schedule.exponent !== 1) {
    throw new Error('Unsupported fee schedule or price');
  }
  return schedule.rate * price * (1 - price);
}

// Polymarket rounds each trade's fee to 5 decimals (docs.polymarket.com/trading/fees); rounding up stays conservative.
export const polymarketFee = (count, perShare) => Math.max(0, Math.ceil(count * perShare * 1e5 - 1e-6)) / 1e5;
