import { fork } from 'node:child_process';
import { PROJECT_ROOT } from './files.js';

// Owns only the market-data process started by this dashboard.
export function createDashboardRunner({ launch = () => fork('scripts/kalshi-gameday.js',
  ['--dashboard', '--feed', '--out=data/dashboard'],
  { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) } = {}) {
  let child = null, stopping = null;
  let data = { running: false, phase: 'idle', hits: [], hitCount: 0, near: [], tracked: [], errors: [], events: 0, markets: 0 };
  const snapshot = () => ({ ...data, running: child !== null, phase: stopping ? 'stopping' : data.phase });
  return {
    snapshot,
    start() {
      if (child) return snapshot();
      data = { ...data, phase: 'starting', startedAt: Date.now(), error: null };
      let owned;
      try { owned = launch(); }
      catch { data.phase = 'stopped'; data.error = 'Scanner could not start'; throw new Error(data.error); }
      child = owned;
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
      if (!child) return snapshot();
      if (stopping) { await stopping; return snapshot(); }
      const owned = child;
      stopping = new Promise(resolve => {
        const timer = setTimeout(() => owned.kill(), 3000);
        owned.once('exit', () => { clearTimeout(timer); resolve(); });
        if (owned.connected) owned.send({ type: 'stop' }, () => {});
        else owned.kill();
      });
      await stopping; stopping = null;
      return snapshot();
    }
  };
}
