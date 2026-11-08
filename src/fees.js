export function takerFeePerShare(price, schedule) {
  if (!Number.isFinite(price) || price < 0 || price > 1 ||
      !Number.isFinite(schedule?.rate) || schedule.rate < 0 || schedule.rate > 1 || schedule.exponent !== 1) {
    throw new Error('Unsupported fee schedule or price');
  }
  return schedule.rate * price * (1 - price);
}
