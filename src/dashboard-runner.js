import { fork, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { PROJECT_ROOT, projectPath } from './files.js';

// The paper agents Start engine runs beside the scanner, as [script name, arguments]; each logs to data/paper/<name>.log and
// <name>.err.log. Paper only; none places an order.
export const PAPER_AGENTS = [['game-watch', ['--budget=split']], ['station-watch', ['--budget=split', '--contracts=10']],
  ['reward-maker', ['--size=25', '--markets=12']], ['longshot-watch', []], ['score-watch', ['--contracts=50']], ['rebalance', []]];
function spawnAgent(name, args) {
  mkdirSync(projectPath('data/paper'), { recursive: true });
  const out = openSync(projectPath(`data/paper/${name}.log`), 'a'), err = openSync(projectPath(`data/paper/${name}.err.log`), 'a');
  try { return spawn(process.execPath, [`scripts/${name}.js`, ...args], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', out, err] }); }
  finally { closeSync(out); closeSync(err); } // the child keeps its own handles
}

// Owns the processes Start engine starts: the market-data loop (also the quoting engine's paper loop, in data/maker) and the paper agents.
export function createDashboardRunner({ launch = () => fork('scripts/kalshi-gameday.js',
  ['--dashboard', '--feed', '--until=never', '--out=data/maker'],
  { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), agents = PAPER_AGENTS, launchAgent = spawnAgent } = {}) {
  let child = null, stopping = null;
  const running = new Map(); // agent name -> its process
  let data = { running: false, phase: 'idle', hits: [], hitCount: 0, near: [], tracked: [], errors: [], events: 0, markets: 0, agentErrors: [] };
  const snapshot = () => ({ ...data, running: child !== null, phase: stopping ? 'stopping' : data.phase, agents: [...running.keys()] });
  function startAgents() {
    for (const [name, args] of agents) {
      if (running.has(name)) continue;
      let proc;
      try { proc = launchAgent(name, args); } catch (error) { data.agentErrors = [...data.agentErrors, `${name}: ${error.message}`]; continue; }
      running.set(name, proc);
      proc.once('exit', code => {
        if (running.get(name) !== proc) return;
        running.delete(name);
        if (!stopping) data.agentErrors = [...data.agentErrors, `${name} exited (code ${code}); see data/paper/${name}.err.log`];
      });
    }
  }
  async function stopAgents() {
    await Promise.all([...running.values()].map(proc => new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', resolve); proc.kill();
    })));
    running.clear();
  }
  return {
    snapshot,
    start() {
      if (child) return snapshot();
      data = { ...data, phase: 'starting', startedAt: Date.now(), error: null };
      let owned;
      try { owned = launch(); }
      catch { data.phase = 'stopped'; data.error = 'Scanner could not start'; throw new Error(data.error); }
      child = owned;
      data.agentErrors = [];
      startAgents();
      owned.on('message', message => {
        if (child !== owned) return;
        if (message.type === 'mode') data = { ...data, mode: message.mode, phase: 'running' };
        if (message.type === 'round') {
          const { round, state } = message;
          const hits = Object.values(state?.open ?? {});
          data = { ...data, phase: 'running', scannedAt: Date.parse(round.at), lastRound: round,
            events: round.tier === 'full' ? round.events : data.events,
            markets: round.watchList?.length ?? round.watchSize ?? data.markets, errors: round.errors ?? [],
            near: round.near ?? data.near,
            hits: hits.slice(0, 25), hitCount: hits.length, tracked: hits.slice(0, 25) };
        }
      });
      owned.once('error', () => {
        data.error = 'Scanner could not start';
        if (!owned.pid) { child = null; data.phase = 'stopped'; }
      });
      owned.once('exit', code => {
        if (child !== owned) return;
        child = null;
        data.phase = 'stopped';
        if (code && !stopping) data.error = 'Scanner exited unexpectedly; restart to retry.';
      });
      return snapshot();
    },
    async stop() {
      if (!child) { await stopAgents(); return snapshot(); } // agents outlive a scanner that exited on its own
      if (stopping) { await stopping; return snapshot(); }
      const owned = child;
      stopping = new Promise(resolve => {
        const timer = setTimeout(() => owned.kill(), 3000);
        owned.once('exit', () => { clearTimeout(timer); resolve(); });
        if (owned.connected) owned.send({ type: 'stop' }, () => {});
        else owned.kill();
      });
      await Promise.all([stopping, stopAgents()]); stopping = null;
      return snapshot();
    }
  };
}
