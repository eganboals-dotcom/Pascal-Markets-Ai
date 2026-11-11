// Agent heartbeats (plan, "How agents report"): one row per state change or check-in, appended to data/agents/<agent>.jsonl as
// { time, agent, state, detail, nextBy? }. nextBy is when the next row is due; an agent past it shows as stale on the dashboard,
// so a silent agent never looks healthy. Rows carry a state and a short detail only: never keys or account data.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectPath } from './files.js';
import { recentRecords } from './dashboard-data.js';

export const HEARTBEAT_DIR = 'data/agents';
const fileOf = (agent, dir) => {
  if (!/^[a-z0-9-]+$/.test(agent ?? '')) throw new Error(`Invalid agent id: ${agent}`);
  return `${dir}/${agent}.jsonl`;
};

// shortcut: files only grow (about 300 rows a day for the odds logger); rotate them once they reach megabytes.
export function beat(agent, state, detail = '', { nextWithinMs = 0, now = Date.now(), dir = HEARTBEAT_DIR } = {}) {
  const row = { time: now, agent, state, detail, ...(nextWithinMs > 0 ? { nextBy: now + nextWithinMs } : {}) };
  const file = projectPath(fileOf(agent, dir));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

export const recentBeats = (agent, { limit = 30, dir = HEARTBEAT_DIR } = {}) => recentRecords(fileOf(agent, dir), limit, 65536);
export const isStale = (row, now = Date.now()) => Boolean(row?.nextBy && now > row.nextBy);
