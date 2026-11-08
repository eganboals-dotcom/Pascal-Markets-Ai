// Authenticated market data only. Native WebSocket answers server Ping frames with Pong.
import { signedHeaders } from './auth.js';

export const FEED_URLS = {
  production: 'wss://external-api-ws.kalshi.com/trade-api/ws/v2',
  demo: 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2'
};

export function feedCredentials(mode, env = process.env) {
  const prefix = mode === 'demo' ? 'KALSHI_DEMO' : 'KALSHI';
  return { keyId: env[`${prefix}_KEY_ID`], keyPath: env[`${prefix}_KEY_PATH`] };
}

export function createFeed({ mode = 'production', env = process.env,
  socketFactory = (url, init) => new WebSocket(url, init),
  headers, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  onTop = () => {}, onError = () => {} } = {}) {
  if (!FEED_URLS[mode]) throw new Error('Invalid feed mode');
  const books = new Map(), desired = new Set(), subscribed = new Set();
  const counts = { messages: 0, snapshots: 0, deltas: 0, gaps: 0, reconnects: 0 };
  let socket, timer, stopped = true, sid, seq, id = 0, backoff = 1000;
  const send = (cmd, params) => socket.send(JSON.stringify({ id: ++id, cmd, params }));
  const invalidate = () => {
    const changed = [...books].filter(([, book]) => !book.stale).map(([ticker]) => ticker);
    for (const book of books.values()) book.stale = true;
    for (const ticker of changed) onTop(ticker, now());
  };
  function reconcile() {
    if (sid == null) return;
    const add = [...desired].filter(t => !subscribed.has(t));
    const drop = [...subscribed].filter(t => !desired.has(t));
    // shortcut: no numeric market cap is published, batch against the documented cap if Kalshi publishes one.
    if (add.length) send('update_subscription', { sids: [sid], market_tickers: add, action: 'add_markets' });
    if (drop.length) send('update_subscription', { sids: [sid], market_tickers: drop, action: 'delete_markets' });
    for (const t of add) subscribed.add(t);
    for (const t of drop) subscribed.delete(t);
  }
  function recover() {
    counts.gaps++;
    invalidate();
    send('update_subscription', { sids: [sid], market_tickers: [...desired], action: 'get_snapshot' });
  }
  function top(ticker) {
    const book = books.get(ticker);
    if (!book || book.stale) return null;
    const best = side => [...book[side]].reduce((a, b) => b[0] > a[0] ? b : a, [0, 0]);
    const [yes, yesSize] = best('yes'), [no, noSize] = best('no');
    return { yes_bid_dollars: yes.toFixed(4), no_bid_dollars: no.toFixed(4),
      yes_ask_dollars: (1 - no).toFixed(4), no_ask_dollars: (1 - yes).toFixed(4),
      yes_bid_size_fp: String(yesSize), yes_ask_size_fp: String(noSize) };
  }
  function connect() {
    if (stopped) return;
    try {
      const credentials = feedCredentials(mode, env);
      // Both keys live outside the repository (like %USERPROFILE%.kalshi), so a private key can never be committed.
      const auth = headers ? headers() : signedHeaders(credentials.keyId, credentials.keyPath, 'GET', '/trade-api/ws/v2', now());
      const current = socket = socketFactory(FEED_URLS[mode], { headers: auth });
      current.addEventListener('open', () => {
        if (current !== socket || stopped) return;
        if (desired.size) {
          send('subscribe', { channels: ['orderbook_delta'], market_tickers: [...desired] });
          for (const t of desired) subscribed.add(t);
        }
      });
      current.addEventListener('message', event => {
        if (current !== socket || stopped) return;
        const receivedAt = now();
        counts.messages++;
        try {
          const data = JSON.parse(event.data), msg = data.msg;
          if (data.type === 'error') { onError(new Error(`Feed subscription error ${msg?.code ?? 'unknown'}`)); current.close(); return; }
          if (data.type === 'subscribed') { sid = msg.sid; backoff = 1000; reconcile(); return; }
          if (!['orderbook_snapshot', 'orderbook_delta'].includes(data.type)) return;
          if (data.sid !== sid || !Number.isSafeInteger(data.seq)) return;
          const gap = seq != null && data.seq !== seq + 1;
          seq = data.seq;
          if (gap) { recover(); return; }
          const ticker = msg.market_ticker;
          if (!desired.has(ticker)) return;
          const before = top(ticker);
          if (data.type === 'orderbook_snapshot') {
            counts.snapshots++;
            const levels = rows => new Map((rows ?? []).map(([p, n]) => {
              p = Number(p); n = Number(n);
              if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isFinite(n) || n < 0) throw new Error('Invalid snapshot');
              return [p, n];
            }).filter(([, n]) => n > 0));
            books.set(ticker, { stale: false, yes: levels(msg.yes_dollars_fp), no: levels(msg.no_dollars_fp) });
          } else {
            counts.deltas++;
            const book = books.get(ticker);
            if (!book || book.stale) return;
            if (!['yes', 'no'].includes(msg.side)) throw new Error('Invalid book side');
            const side = book[msg.side], p = Number(msg.price_dollars), n = (side.get(p) ?? 0) + Number(msg.delta_fp);
            if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isFinite(n) || n < 0) throw new Error('Invalid book delta');
            if (n === 0) side.delete(p); else side.set(p, Math.round(n * 100) / 100);
          }
          const after = top(ticker);
          if (JSON.stringify(before) !== JSON.stringify(after)) onTop(ticker, receivedAt);
        } catch { onError(new Error('Invalid feed message; recovering subscription')); if (sid != null) recover(); }
      });
      current.addEventListener('error', () => { if (current === socket && !stopped) { onError(new Error('Feed connection failed')); current.close(); } });
      current.addEventListener('close', () => { if (current === socket && !stopped) retry(); });
    } catch { onError(new Error('Feed connection or signing failed')); retry(); }
  }
  function retry() {
    invalidate(); sid = undefined; seq = undefined; subscribed.clear();
    counts.reconnects++;
    timer = schedule(connect, backoff);
    backoff = Math.min(30000, backoff * 2);
  }
  return {
    books, counts, top,
    setMarkets(tickers) {
      desired.clear(); for (const t of tickers) desired.add(t);
      for (const t of books.keys()) if (!desired.has(t)) books.delete(t);
      if (socket?.readyState === 1) {
        if (sid == null && !subscribed.size && desired.size) {
          send('subscribe', { channels: ['orderbook_delta'], market_tickers: [...desired] });
          for (const t of desired) subscribed.add(t);
        } else reconcile();
      }
    },
    start() { if (stopped) { stopped = false; connect(); } },
    stop() { stopped = true; cancel(timer); invalidate(); socket?.close(); }
  };
}
