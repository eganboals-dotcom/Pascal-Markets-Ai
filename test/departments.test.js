import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { departmentOf, loadDepartments, readSwitches, scoreboard, writeSwitch } from '../src/departments.js';
import { projectPath } from '../src/files.js';

const departments = loadDepartments();
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('each series lands in one department by the first matching pattern', () => {
  const cases = {
    KXBTC15M: 'updown', KXINXU: 'updown', KXCPIYOY: 'updown', KXUSDJPY: 'updown', KXHIGHNY: 'weather', KXLOWTDEN: 'weather', KXRAIN: 'weather',
    SENATETX: 'politics', CONTROLH: 'politics', KXTRUMPAPPROVE: 'politics', KXNBAGAME: 'sportsUS', KXNCAAFSPREAD: 'sportsUS', KXMLSGAME: 'sportsUS',
    KXEPLGAME: 'soccerIntl', KXBRASILEIROTOTAL: 'soccerIntl', KXLIGAMXSCORE: 'soccerIntl',
    // Lookalikes: Euroleague is basketball, not the euro; electronics ads are not elections; tennis has no department of its own.
    KXEUROLEAGUESPREAD: 'else', KXELECTRONICSADS: 'else', KXATPMATCH: 'else',
  };
  for (const [series, id] of Object.entries(cases)) assert.equal(departmentOf(series, departments), id, series);
});

test('the scoreboard splits trades by series, keeps cross-venue hedges in arbitrage and counts maker fills', () => {
  const board = scoreboard([
    { agent: 'weather', trades: [{ day: '2026-11-01', ticker: 'KXHIGHNY-26NOV01-B60.5', pnl: 0.4 }, { day: '2026-11-09', ticker: 'KXHIGHNY-26NOV09-B61.5', pnl: -0.1 }] },
    { agent: 'maker', trades: [{ day: '2026-11-09', ticker: 'KXNBAGAME-26NOV09BOSNYK-BOS', pnl: 0.05, clv: 0.02, fills: 3 }] },
    { agent: 'crossvenue', department: 'arbitrage', trades: [{ day: '2026-11-09', ticker: 'KXNBAGAME-26NOV09BOSNYK-NYK', pnl: 0.01 }] },
  ], departments);
  const row = id => board.find(r => r.id === id);
  assert.equal(row('weather').trades, 2);
  near(row('weather').settled.total, 0.3);
  near(row('weather').lastDay, -0.1);
  near(row('weather').week, -0.1); // Nov 1 is outside the 7 calendar days ending Nov 9
  assert.equal(row('weather').wins, 1);
  assert.equal(row('sportsUS').trades, 3);
  near(row('sportsUS').clv, 0.02);
  assert.deepEqual(Object.keys(row('sportsUS').agents), ['maker']);
  assert.equal(row('arbitrage').records, 1);
  assert.equal(row('politics').trades, 0);
  assert.equal(board[0].id, 'weather'); // ranked by settled profit
});

test('switches start on, save per department and refuse unknown departments or non-boolean values', () => {
  const path = `work/switches-${randomUUID()}.json`;
  try {
    assert.ok(Object.values(readSwitches(departments, path)).every(Boolean));
    writeSwitch(departments, 'weather', false, path);
    assert.deepEqual(Object.entries(readSwitches(departments, path)).filter(([, on]) => !on), [['weather', false]]);
    assert.throws(() => writeSwitch(departments, 'nope', false, path), /Unknown department/);
    assert.throws(() => writeSwitch(departments, 'weather', 'off', path), /true or false/);
  } finally { rmSync(projectPath(path), { force: true }); }
});
