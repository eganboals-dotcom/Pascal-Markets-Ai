import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runScan } from './scan.js';

// Full-scan basket enumeration must not block incoming feed messages on the main thread.
export function backgroundScan(config, pairs, now, options, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scan-worker.js', import.meta.url), { workerData: { config, pairs, now, options } });
    let settled = false;
    const finish = (error, scan) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(scan);
    };
    const abort = () => finish(new Error('Full scan stopped'));
    worker.once('message', message => message.error ? finish(new Error(message.error)) : finish(null, message.scan));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Full scan worker exited ${code}`)); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

if (!isMainThread) {
  const { config, pairs, now, options } = workerData;
  runScan(config, pairs, now, options).then(scan => parentPort.postMessage({ scan }),
    error => parentPort.postMessage({ error: error.message }));
}
