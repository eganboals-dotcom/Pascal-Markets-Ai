import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordStream } from '../src/streams.js';
import { projectPath } from '../src/files.js';

class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor() {
    super();
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      this.dispatchEvent(new MessageEvent('message', { data: 'ping' }));
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ leagueAbbreviation: 'NBA', gameId: 1 }) }));
    });
  }
  send(value) { this.sent.push(value); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

test('stream sends subscription, replies to heartbeat, and archives session boundaries', async () => {
  const path = `data/test-stream-${Date.now()}.jsonl`;
  const result = await recordStream({ path, source: 'test', url: 'wss://unused', durationSeconds: 1,
    subscription: { type: 'market', assets_ids: ['1'] }, WebSocketClass: FakeSocket });
  assert.equal(result.count, 1);
  assert.equal(result.connections, 1);
  const sent = FakeSocket.instances.at(-1).sent;
  assert.equal(sent[0], '{"type":"market","assets_ids":["1"]}');
  assert.equal(sent[1], 'pong');
  const rows = readFileSync(projectPath(path), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.kind), ['connecting', 'connected', 'data', 'end']);
  assert.ok(rows.every(row => row.recordingId === result.recordingId && row.session === 1));
});

test('malformed stream frames fail explicitly', async () => {
  class MalformedSocket extends FakeSocket {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'invalid-json' })));
    }
  }
  await assert.rejects(recordStream({ path: `data/test-malformed-${Date.now()}.jsonl`, source: 'test',
    url: 'wss://unused', durationSeconds: 1, WebSocketClass: MalformedSocket }), /Invalid test frame/);
});

test('recording without an established connection is an error', async () => {
  class NeverOpens extends EventTarget { close() {} }
  await assert.rejects(recordStream({ path: `data/test-unconnected-${Date.now()}.jsonl`, source: 'test',
    url: 'wss://unused', durationSeconds: 1, WebSocketClass: NeverOpens }), /never established/);
});
