import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectPath } from './files.js';

export function recordStream({ path, source, url, durationSeconds, subscription,
  filter = () => true, sendHeartbeat = false, WebSocketClass = WebSocket }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) {
    throw new Error('Recording duration must be between 1 and 86400 seconds');
  }
  path = projectPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const recordingId = randomUUID();
  let socket;
  let session = 0;
  let count = 0;
  let reconnects = 0;
  let connections = 0;
  let finished = false;
  let heartbeatTimer;
  let retryTimer;
  let lastMessageAt = Date.now();
  function append(kind, payload) {
    appendFileSync(path, JSON.stringify({ recordingId, session, source, receivedAt: Date.now(), kind, payload }) + '\n');
  }
  return new Promise((resolve, reject) => {
    const durationTimer = setTimeout(() => finish(), durationSeconds * 1000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(durationTimer);
      clearTimeout(retryTimer);
      clearInterval(heartbeatTimer);
      socket?.close();
      if (!error && connections === 0) error = new Error(`${source} never established a connection`);
      try { append('end', { count, connections, reconnects, error: error?.message ?? null }); }
      catch (writeError) { error = writeError; }
      if (error) reject(error);
      else resolve({ recordingId, count, connections, reconnects, path });
    }
    function connect() {
      if (finished) return;
      session++;
      try {
        append('connecting', {});
        socket = new WebSocketClass(url);
      } catch (error) { finish(error); return; }
      const connection = socket;
      lastMessageAt = Date.now();
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > 30000) {
          connection.close();
          return;
        }
        if (sendHeartbeat && connection.readyState === 1) connection.send('PING');
      }, 10000);
      connection.addEventListener('open', () => {
        if (finished) return;
        connections++;
        try {
          append('connected', {});
          if (subscription) connection.send(JSON.stringify(subscription));
        } catch (error) { finish(error); }
      });
      connection.addEventListener('message', event => {
        if (finished || connection !== socket) return;
        lastMessageAt = Date.now();
        if (event.data === 'ping') { connection.send('pong'); return; }
        if (event.data === 'PONG') return;
        try {
          const value = JSON.parse(event.data);
          const messages = Array.isArray(value) ? value : [value];
          for (const payload of messages) {
            if (filter(payload)) { append('data', payload); count++; }
          }
        } catch (error) { finish(new Error(`Invalid ${source} frame or recording write failure: ${error.message}`)); }
      });
      connection.addEventListener('error', () => connection.close());
      connection.addEventListener('close', () => {
        clearInterval(heartbeatTimer);
        if (finished) return;
        try { append('gap', { reason: 'connection-closed' }); }
        catch (error) { finish(error); return; }
        reconnects++;
        if (reconnects > 5) { finish(new Error(`${source} exceeded five reconnect attempts`)); return; }
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** (reconnects - 1), 10000));
      });
    }
    connect();
  });
}
