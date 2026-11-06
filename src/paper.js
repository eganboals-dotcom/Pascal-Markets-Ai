import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sportsContract } from './catalog.js';
import { takerFeePerShare } from './fees.js';
import { projectPath, writeProjectFile } from './files.js';

const initialCash = 1000;
const orderCap = 25;
const exposureCap = 100;

function account(orders) {
  let cash = initialCash;
  let exposure = 0;
  let reserved = 0;
  let pnl = 0;
  for (const order of orders) {
    if (order.state === 'pending') reserved += order.budget;
    if (order.state === 'filled' || order.state === 'settled') cash -= order.cost;
    if (order.state === 'filled') exposure += order.cost;
    if (order.state === 'settled') {
      cash += order.payout;
      pnl += order.payout - order.cost;
    }
  }
  return { cash, exposure, reserved, pnl, initialCash, orderCap, exposureCap, orders: [...orders].reverse() };
}

export function bookTop(book, assetId) {
  if (book?.asset_id !== assetId || !Array.isArray(book.asks) || !Array.isArray(book.bids)) throw new Error('Order book identity unavailable');
  const levels = entries => entries.map(entry => ({ price: Number(entry.price), size: Number(entry.size) }))
    .filter(level => level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0);
  return { sourceAt: Number(book.timestamp), asks: levels(book.asks).sort((a, b) => a.price - b.price).slice(0, 12),
    bids: levels(book.bids).sort((a, b) => b.price - a.price).slice(0, 12) };
}

function marketTerms(contract, expected, assetId) {
  if (!contract?.acceptingOrders || contract.marketId !== expected.marketId || contract.conditionId !== expected.conditionId ||
      contract.rulesHash !== expected.rulesHash || contract.version !== expected.version ||
      !contract.outcomes.every((outcome, index) => outcome.assetId === expected.outcomes[index].assetId && outcome.label === expected.outcomes[index].label) ||
      !contract.outcomes.some(outcome => outcome.assetId === assetId) ||
      !Number.isFinite(contract.secondsDelay) || contract.secondsDelay < 0 || contract.secondsDelay > 60 ||
      !Number.isFinite(contract.minOrderSize) || contract.minOrderSize <= 0 ||
      !Number.isFinite(contract.tickSize) || contract.tickSize <= 0 || typeof contract.feesEnabled !== 'boolean') {
    throw new Error('Market closed, changed, or missing trading terms');
  }
  if (contract.feesEnabled) takerFeePerShare(0.5, contract.feeSchedule);
  return contract;
}

export function createPaperDesk({ loadMarket, loadBook, loadResolution, path = 'data/paper-ledger.json', now = Date.now, wait = sleep }) {
  const ledger = projectPath(path);
  function read() {
    let orders;
    try { orders = JSON.parse(readFileSync(ledger, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!Array.isArray(orders)) throw new Error('Invalid paper ledger');
    return orders.map(order => order.state === 'pending' && order.expiresAt < now()
      ? { ...order, state: 'unfilled', reason: 'Execution window expired' } : order);
  }
  function update(change) {
    mkdirSync(dirname(ledger), { recursive: true });
    const lock = projectPath(`${ledger}.lock`);
    const handle = openSync(lock, 'wx');
    try {
      const orders = read();
      const result = change(orders);
      writeProjectFile(ledger, JSON.stringify(orders, null, 2));
      return result;
    } finally { closeSync(handle); unlinkSync(lock); }
  }

  async function submit(expected, { requestId, assetId, limitPrice, budget }) {
    if (typeof requestId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId) ||
        !Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1 ||
        !Number.isFinite(budget) || budget <= 0 || budget > orderCap) throw new Error('Invalid paper order or budget exceeds the order cap');
    const previous = read().find(order => order.id === requestId);
    if (previous) return previous;
    const refresh = async () => marketTerms(sportsContract({ id: expected.eventId, title: expected.title },
      await loadMarket(expected.marketId)), expected, assetId);
    const initial = await refresh();
    const ticks = limitPrice / initial.tickSize;
    if (Math.abs(ticks - Math.round(ticks)) > 1e-8) throw new Error('Limit price must match the market tick size');
    const unitLimit = limitPrice + (initial.feesEnabled ? takerFeePerShare(limitPrice, initial.feeSchedule) : 0);
    const shares = Math.floor((budget - 0.000005) / unitLimit);
    if (shares < initial.minOrderSize) throw new Error('Budget cannot cover the market minimum order size');
    const submittedAt = now();
    const eligibleAt = submittedAt + Math.max(1000, initial.secondsDelay * 1000);
    const pending = update(orders => {
      const duplicate = orders.find(order => order.id === requestId);
      if (duplicate) return { order: duplicate, created: false };
      const balance = account(orders);
      if (balance.cash - balance.reserved < budget || balance.exposure + balance.reserved + budget > exposureCap) {
        throw new Error('Paper cash or total exposure limit exceeded');
      }
      const order = { id: requestId, marketId: initial.marketId, title: initial.title, conditionId: initial.conditionId,
        outcome: initial.outcomes.find(outcome => outcome.assetId === assetId).label,
        outcomeIndex: initial.outcomes.findIndex(outcome => outcome.assetId === assetId),
        assetId, limitPrice, budget, submittedAt, eligibleAt, expiresAt: eligibleAt + 18000, state: 'pending' };
      orders.push(order);
      return { order, created: true };
    });
    if (!pending.created) return pending.order;
    let fill;
    try {
      await wait(Math.max(0, eligibleAt - now()));
      const [contract, book] = await Promise.all([refresh(), loadBook(assetId)]);
      const terms = value => JSON.stringify([value.secondsDelay, value.minOrderSize, value.tickSize,
        value.feesEnabled, value.feeSchedule?.rate, value.feeSchedule?.exponent]);
      if (terms(initial) !== terms(contract)) throw new Error('Trading terms changed during the delay');
      if (book.market !== initial.conditionId) throw new Error('Order book condition changed');
      const top = bookTop(book, assetId);
      const checkedAt = now();
      if (!Number.isFinite(top.sourceAt) || top.sourceAt < eligibleAt || top.sourceAt > checkedAt || checkedAt - top.sourceAt > 5000) {
        throw new Error('No fresh quote arrived after the matching delay');
      }
      const best = top.asks[0];
      if (!best || best.price > limitPrice) throw new Error('No depth at the limit price');
      fill = { filledAt: checkedAt, bookSourceAt: top.sourceAt, price: best.price, depth: best.size,
        unitFee: contract.feesEnabled ? takerFeePerShare(best.price, contract.feeSchedule) : 0 };
    } catch (error) { fill = { reason: error.code ? 'Market data unavailable' : error.message }; }
    return update(orders => {
      const order = orders.find(order => order.id === requestId);
      if (order.state !== 'pending') return order;
      if (fill.reason) return Object.assign(order, { state: 'unfilled', reason: fill.reason });
      const used = orders.filter(previous => previous.assetId === assetId && previous.bookSourceAt === fill.bookSourceAt &&
        previous.price === fill.price).reduce((sum, previous) => sum + previous.shares, 0);
      const filledShares = Math.min(shares, Math.floor(fill.depth - used));
      if (filledShares < 1) return Object.assign(order, { state: 'unfilled', reason: 'No remaining displayed depth' });
      const fee = Math.round(fill.unitFee * filledShares * 1e5) / 1e5;
      const cost = filledShares * fill.price + fee;
      if (cost > budget) return Object.assign(order, { state: 'unfilled', reason: 'Fill exceeds reserved budget' });
      Object.assign(order, { state: 'filled', filledAt: fill.filledAt, bookSourceAt: fill.bookSourceAt,
        shares: filledShares, price: fill.price, fee, cost });
      return order;
    });
  }

  async function settle() {
    const conditions = [...new Set(read().filter(order => order.state === 'filled').map(order => order.conditionId))];
    const settled = new Map();
    let failures = 0;
    await Promise.all(conditions.slice(0, 20).map(async condition => {
      try {
        const result = await loadResolution(condition);
        const resolvedAt = Date.parse(result?.resolved_at);
        if (result?.condition_id !== condition || result.status !== 'resolved' || !Number.isFinite(resolvedAt) || resolvedAt > now()) return;
        const payouts = result.payouts;
        if (!Array.isArray(payouts) || payouts.length !== 2 || !payouts.every(value => Number.isFinite(value) && value >= 0)) return;
        const total = payouts[0] + payouts[1];
        if (total === 1 || total === 1000000) settled.set(condition, { resolvedAt, payouts: payouts.map(value => value / total) });
      } catch { failures++; }
    }));
    return update(orders => {
      let count = 0;
      for (const order of orders) {
        const resolution = settled.get(order.conditionId);
        if (order.state !== 'filled' || !resolution || resolution.resolvedAt < order.filledAt) continue;
        Object.assign(order, { state: 'settled', settledAt: resolution.resolvedAt,
          payout: order.shares * resolution.payouts[order.outcomeIndex] });
        count++;
      }
      return { count, failures, ...account(orders) };
    });
  }
  return { status: () => account(read()), submit, settle };
}
