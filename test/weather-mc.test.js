import test from 'node:test';
import assert from 'node:assert/strict';
import { fairPrice, fitErrors, forecastAt, hourlyErrors, rng, simulateDay, trainingDay } from '../src/agents/weather-mc.js';

const HOUR = 3600000, start = Date.parse('2026-10-20T00:00Z');
const flat = (temp, hours = 72) => ({ start, temps: Array(hours).fill(temp) });

test('forecasts interpolate between hours and readings line up with the nearest whole hour', () => {
  const f = { start, temps: [60, 64, NaN] };
  assert.equal(forecastAt(f, start + HOUR / 2), 62);
  assert.equal(forecastAt(f, start + HOUR), 64); // the last good hour itself
  assert.ok(Number.isNaN(forecastAt(f, start + 1.5 * HOUR)));
  assert.ok(Number.isNaN(forecastAt(f, start - 1)));
  const readings = [{ time: start - 4 * 60000, temp: 61 }, { time: start + 8 * 60000, temp: 99 }, { time: start + HOUR + 20 * 60000, temp: 70 }];
  assert.deepEqual(hourlyErrors(readings, f, start, start + 2 * HOUR), [{ time: start, error: 1 }]); // 01:20 is too far from 01:00
});

test('the error model recovers a known bias, persistence and spread', () => {
  const rand = rng(3), normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const errors = [];
  let e = 2;
  for (let h = 0; h < 2000; h++) { e = 2 + 0.8 * (e - 2) + normal(); errors.push({ time: start + h * HOUR, error: e }); }
  const m = fitErrors(errors);
  assert.ok(Math.abs(m.bias - 2) < 0.4 && Math.abs(m.rho - 0.8) < 0.05 && Math.abs(m.sd - 1) < 0.1, JSON.stringify(m));
  assert.equal(fitErrors(errors.slice(0, 50)), null);
  assert.deepEqual(rng(5)(), rng(5)()); // seeded
});

// Hourly readings from 24 hours before a climate day to its end: `temp` everywhere, `peak` at 15:00 into the day.
const day = (dayStart, temp, peak = temp) => Array.from({ length: 48 }, (_, i) => ({ time: dayStart + (i - 24) * HOUR, temp: i === 39 ? peak : temp }));

test('a training day keeps its readings, forecast and report gaps', () => {
  const dayStart = start + 24 * HOUR, t = trainingDay(day(dayStart, 72, 75), flat(70), dayStart, { high: 76, low: 71 });
  assert.equal(t.reads[39], 75);
  assert.equal(t.fc[0], 70);
  assert.deepEqual(t.gapAll, { high: 1, low: -1 });
  assert.deepEqual(t.gapHourly, { high: 1, low: -1 });
  assert.equal(trainingDay(day(dayStart, 72), flat(70), dayStart, { high: 72 }), null); // no low reported
  assert.equal(trainingDay(day(dayStart, 72).slice(0, 30), flat(70), dayStart, { high: 72, low: 72 }), null); // too few hours
});

test('simulated days replay earlier misses and respect the readings so far', () => {
  const dayStart = start + 24 * HOUR, dayEnd = dayStart + 24 * HOUR;
  // One earlier day that ran 2 above a flat 70 forecast and peaked at 75 against a report of 76.
  const forecast = { start: start - 48 * HOUR, temps: Array(200).fill(70) };
  const days = [trainingDay(day(dayStart - 24 * HOUR, 72, 75), forecast, dayStart - 24 * HOUR, { high: 76, low: 71 })];
  const base = { kind: 'high', dayStart, forecast, days, rho: 0.9, jitter: 0, sims: 50 };
  // Before the day: the forecast's 70 plus that day's miss on its peak (75 − 70) plus its hourly gap (1).
  assert.deepEqual([...new Set(simulateDay({ ...base, from: start + 12 * HOUR }))], [76]);
  // The latest reading 3 warmer against the forecast than that day was at the same hour moves it up (fading by rho an hour).
  const warm = simulateDay({ ...base, from: dayStart, e0: 5, rho: 1 });
  assert.deepEqual([...new Set(warm)], [79]);
  // The day is over: the high so far plus that day's all-readings gap, rounded.
  assert.deepEqual([...new Set(simulateDay({ ...base, soFar: 75.4, from: dayEnd }))], [76]);
  // A high of 80 so far: a range below 80 cannot pay.
  const hot = simulateDay({ ...base, soFar: 80, from: dayStart + 15 * HOUR });
  assert.equal(fairPrice({ strike_type: 'between', floor_strike: 77, cap_strike: 78 }, hot), 0);
  assert.equal(fairPrice({ strike_type: 'greater', floor_strike: 79 }, hot), 1);
  // Lows: the forecast's 70 plus that day's miss on its lowest hour (72 − 70) plus its hourly gap (−1). Jitter spreads the days out; the same seed gives the same days.
  assert.deepEqual([...new Set(simulateDay({ ...base, kind: 'low', from: start + 12 * HOUR }))], [71]);
  const spread = simulateDay({ ...base, jitter: 1, sims: 500, from: start + 12 * HOUR });
  assert.ok(new Set(spread).size >= 3);
  assert.deepEqual(spread, simulateDay({ ...base, jitter: 1, sims: 500, from: start + 12 * HOUR }));
  assert.deepEqual(simulateDay({ ...base, days: [], from: dayStart }), []);
  assert.equal(fairPrice({ strike_type: 'less', cap_strike: 50 }, []), null);
});
