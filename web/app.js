const el = id => document.getElementById(id);
const text = (id, value) => { el(id).textContent = value; };
const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
const number = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const money = value => Number.isFinite(value) ? usd.format(value) : '—';
const cents = value => Number.isFinite(value) ? number(value * 100) + '¢' : '—';
const time = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
const label = value => String(value ?? '').replaceAll('_', ' ');
let events = [];
let selected;
let contract;
let outcome;
let quoteRequest = 0;
let eventRequest = 0;
let outcomeVersion = 0;
let currentSearch = '';
let submitting = false;
let captureRows = [];
let pendingRequest;

function node(tag, value, style) {
  const item = document.createElement(tag);
  if (value !== undefined) item.textContent = value;
  if (style) item.className = style;
  return item;
}

async function api(path, payload) {
  const response = await fetch(path, payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

function table(headers, rows, style) {
  const element = node('table', undefined, style);
  const head = element.createTHead().insertRow();
  headers.forEach(header => {
    const cell = node('th', header);
    cell.scope = 'col';
    head.append(cell);
  });
  const body = element.createTBody();
  rows.forEach(row => {
    const line = body.insertRow();
    row.forEach(value => { line.insertCell().textContent = value; });
  });
  return element;
}

function eventCard(event) {
  const button = node('button', undefined, 'card' + (selected?.id === event.id ? ' active' : ''));
  button.type = 'button';
  button.setAttribute('aria-pressed', String(selected?.id === event.id));
  const tags = node('span', undefined, 'card-meta');
  tags.append(node('span', event.league.toUpperCase() + ' · ' + (event.live ? event.score || 'IN PLAY' : time(event.startsAt))),
    node('span', event.marketCount + (event.marketCount === 1 ? ' contract' : ' contracts')));
  const prices = node('span', undefined, 'card-prices');
  event.outcomes.forEach(item => prices.append(node('span', item.label + ' ' + cents(item.price))));
  button.append(node('span', event.title, 'card-title'), tags, prices);
  button.addEventListener('click', () => selectEvent(event));
  return button;
}

function showLanes() {
  const league = el('league').value;
  const filtered = events.filter(event => !league || event.league === league);
  text('event-count', number(filtered.length));
  for (const [name, list] of [['live', filtered.filter(event => event.live)], ['scheduled', filtered.filter(event => !event.live)]]) {
    text(name + '-count', number(list.length));
    el(name + '-events').replaceChildren(...(list.length ? list.map(eventCard) : [
      node('p', name === 'live' ? 'No live events in this view.' : 'No scheduled events in this view.', 'empty')
    ]));
  }
}

function showCaptures() {
  text('capture-count', number(captureRows.length));
  el('captures').replaceChildren(...(captureRows.length ? captureRows.map(capture => {
    const card = node('div', undefined, 'card');
    const tags = node('div', undefined, 'card-meta');
    tags.append(node('span', capture.state), node('span', capture.markets.length + ' markets'));
    const counts = node('div', undefined, 'card-prices');
    counts.append(node('span', number(capture.messages) + ' messages'), node('span', number(capture.quotes) + ' quotes'));
    if (Number.isFinite(capture.sportsbook)) counts.append(node('span', number(capture.sportsbook) + ' sportsbook'));
    card.append(node('span', capture.markets.map(market => market.title).join(' / ') || capture.name, 'card-title'), tags, counts);
    return card;
  }) : [node('p', 'Recordings from the capture commands appear here.', 'empty')]));
}

function showLedger(paper) {
  if (!paper) return;
  text('cash', money(paper.cash - paper.reserved));
  text('exposure', money(paper.exposure + paper.reserved));
  text('reserved', money(paper.reserved) + ' reserved');
  text('pnl', money(paper.pnl));
  el('pnl').className = paper.pnl > 0 ? 'positive' : paper.pnl < 0 ? 'negative' : '';
  el('orders').replaceChildren(paper.orders.length ? table(['Market', 'Outcome', 'Status', 'Shares', 'Price', 'Cost', 'Payout'],
    paper.orders.map(order => [order.title, order.outcome, order.state + (order.reason ? ' · ' + order.reason : ''),
      number(order.shares), cents(order.price), money(order.cost), money(order.payout)])) :
    node('p', 'Paper orders will appear here.', 'muted'));
}

function renderStatus(data) {
  captureRows = data.captures;
  showCaptures();
  showLedger(data.paper);
  if (data.demo) {
    el('demo-details').replaceChildren(table(['Synthetic experiment', 'Fills', 'Example P&L'], [
      ['Sportsbook odds', number(data.demo.sportsbookReplay.fills), money(data.demo.sportsbookReplay.netPnl)],
      ['NBA model', number(data.demo.modelReplay.fills), money(data.demo.modelReplay.netPnl)]
    ]));
  }
}

function drawChart(points) {
  if (points.length < 2) {
    el('chart').replaceChildren(node('p', 'No price history for this outcome.'));
    return;
  }
  const ordered = [...points].sort((a, b) => a.t - b.t);
  const start = ordered[0].t;
  const duration = ordered.at(-1).t - start || 1;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 760 150');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Outcome price history from ' + cents(ordered[0].p) + ' to ' + cents(ordered.at(-1).p));
  for (const price of [0, .25, .5, .75, 1]) {
    const y = 12 + 122 * (1 - price);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', 8);
    line.setAttribute('x2', 706);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', '#292b3b');
    const tick = document.createElementNS(ns, 'text');
    tick.setAttribute('x', 713);
    tick.setAttribute('y', y + 4);
    tick.textContent = cents(price);
    svg.append(line, tick);
  }
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', ordered.map(point => (8 + 698 * (point.t - start) / duration) + ',' + (12 + 122 * (1 - point.p))).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#ac9cff');
  line.setAttribute('stroke-width', '2.5');
  svg.append(line);
  el('chart').replaceChildren(svg);
}

async function loadQuote(withChart = false) {
  if (!outcome) return;
  const id = ++quoteRequest;
  const version = outcomeVersion;
  const asset = encodeURIComponent(outcome.assetId);
  const [book, history] = await Promise.allSettled([
    api('/api/book?asset=' + asset),
    withChart ? api('/api/history?asset=' + asset) : Promise.resolve(null)
  ]);
  if (version !== outcomeVersion) return;
  if (withChart) drawChart(history.status === 'fulfilled' ? history.value : []);
  if (id !== quoteRequest) return;
  if (book.status === 'fulfilled') {
    const { bids, asks, sourceAt } = book.value;
    text('book-time', 'Source ' + time(sourceAt));
    el('book').replaceChildren(table(['Bid', 'Shares'], bids.slice(0, 4).map(level => [cents(level.price), number(level.size)]), 'bids'),
      table(['Ask', 'Shares'], asks.slice(0, 4).map(level => [cents(level.price), number(level.size)]), 'asks'));
    if (!el('limit').value && asks[0]) el('limit').value = asks[0].price;
  } else {
    text('book-time', 'Book unavailable');
    el('book').replaceChildren();
  }
}

function ticketState() {
  el('place').disabled = !contract?.acceptingOrders || !outcome || !el('reviewed').checked || submitting;
}

function selectOutcome(item) {
  outcomeVersion++;
  outcome = item;
  for (const button of el('outcomes').children) button.setAttribute('aria-pressed', String(button.dataset.asset === item.assetId));
  text('ticket-outcome', item.label);
  text('book-time', 'Loading order book…');
  el('limit').value = '';
  el('book').replaceChildren();
  el('chart').replaceChildren(node('p', 'Loading price history…'));
  ticketState();
  loadQuote(true);
}

function selectContract(id) {
  contract = selected.markets.find(item => item.marketId === id);
  text('market-title', contract.title);
  text('market-league', selected.league.toUpperCase() + ' / ' + label(contract.type).toUpperCase());
  text('market-state', contract.acceptingOrders ? 'Book open' : 'Orders paused');
  text('rules', contract.rules);
  text('delay', 'Venue delay ' + number(contract.secondsDelay) + ' s');
  text('size', 'Minimum ' + number(contract.minOrderSize) + ' shares');
  el('reviewed').checked = false;
  el('outcomes').replaceChildren(...contract.outcomes.map(item => {
    const button = node('button', item.label + ' · ' + cents(item.price));
    button.type = 'button';
    button.dataset.asset = item.assetId;
    button.addEventListener('click', () => selectOutcome(item));
    return button;
  }));
  selectOutcome(contract.outcomes[0]);
}

async function selectEvent(event) {
  const id = ++eventRequest;
  const search = currentSearch;
  selected = event;
  contract = undefined;
  outcome = undefined;
  outcomeVersion++;
  ticketState();
  el('contract').disabled = true;
  el('contract').replaceChildren(node('option', 'Loading contracts…'));
  el('outcomes').replaceChildren();
  el('book').replaceChildren();
  el('chart').replaceChildren(node('p', 'Select an outcome to see price history.'));
  text('market-title', event.title);
  text('market-state', 'Loading');
  text('ticket-outcome', 'Loading event contracts…');
  text('rules', 'Select a contract to view the rules.');
  text('book-time', 'Select an outcome');
  showLanes();
  let detail;
  try { detail = await api('/api/event?id=' + encodeURIComponent(event.id) + '&search=' + encodeURIComponent(search)); }
  catch (error) {
    if (id === eventRequest) {
      text('market-state', 'Unavailable');
      text('ticket-outcome', error.message);
    }
    return;
  }
  if (id !== eventRequest) return;
  selected = detail;
  el('contract').replaceChildren(...selected.markets.map(item => {
    const option = node('option', label(item.type) + ' · ' + item.title);
    option.value = item.marketId;
    return option;
  }));
  el('contract').disabled = false;
  selectContract(selected.markets[0].marketId);
}

async function refresh() {
  if (el('refresh').disabled) return;
  el('refresh').disabled = true;
  const query = currentSearch;
  try {
    const [board, status] = await Promise.allSettled([api('/api/markets?search=' + encodeURIComponent(query)), api('/api/status')]);
    if (status.status === 'fulfilled') renderStatus(status.value);
    if (board.status === 'rejected') {
      text('updated', events.length ? 'Feed unavailable · showing last refresh' : 'Sports feed unavailable');
      if (!events.length) showLanes();
      return;
    }
    events = board.value.events;
    const leagues = [...new Set(events.map(event => event.league))].sort();
    const previous = el('league').value;
    el('league').replaceChildren(node('option', 'All leagues'), ...leagues.map(league => {
      const option = node('option', league.toUpperCase());
      option.value = league;
      return option;
    }));
    el('league').options[0].value = '';
    el('league').value = leagues.includes(previous) ? previous : '';
    text('league-count', number(leagues.length) + ' leagues');
    text('updated', 'Checked ' + time(Date.now()));
    if (events.length && (!selected || !events.some(event => event.id === selected.id))) selectEvent(events.find(event => event.live) ?? events[0]);
    else if (!events.length) {
      selected = undefined;
      contract = undefined;
      outcome = undefined;
      eventRequest++;
      outcomeVersion++;
      el('contract').disabled = true;
      el('outcomes').replaceChildren();
      text('market-state', 'No matching events');
      ticketState();
      showLanes();
    } else {
      showLanes();
      loadQuote();
    }
  } finally {
    el('refresh').disabled = false;
    if (currentSearch !== query) refresh();
  }
}

el('refresh').addEventListener('click', refresh);
el('search-form').addEventListener('submit', event => {
  event.preventDefault();
  currentSearch = el('search').value.trim();
  refresh();
});
el('league').addEventListener('change', showLanes);
el('contract').addEventListener('change', () => selectContract(el('contract').value));
el('reviewed').addEventListener('change', ticketState);
el('ticket').addEventListener('submit', async event => {
  event.preventDefault();
  if (el('place').disabled) return;
  submitting = true;
  ticketState();
  text('order-status', 'Checking the book after the matching delay…');
  const input = { marketId: contract.marketId, rulesHash: contract.rulesHash, assetId: outcome.assetId,
    budget: Number(el('budget').value), limitPrice: Number(el('limit').value), reviewed: el('reviewed').checked };
  const key = JSON.stringify(input);
  pendingRequest = pendingRequest?.key === key ? pendingRequest : { key, id: crypto.randomUUID() };
  try {
    const order = await api('/api/paper/orders', { ...input, requestId: pendingRequest.id });
    text('order-status', order.state === 'filled' ? 'Filled ' + order.shares + ' shares at ' + cents(order.price) :
      order.state + (order.reason ? ' · ' + order.reason : ''));
    if (order.state !== 'pending') pendingRequest = null;
    renderStatus(await api('/api/status'));
  } catch (error) { text('order-status', error.message); }
  finally { submitting = false; ticketState(); }
});
el('settle').addEventListener('click', async () => {
  el('settle').disabled = true;
  try {
    const result = await api('/api/paper/settle', {});
    showLedger(result);
    text('settle-status', result.count + ' orders settled' + (result.failures ? ' · ' + result.failures + ' checks unavailable' : ''));
  } catch (error) { text('settle-status', error.message); }
  finally { el('settle').disabled = false; }
});
refresh();
setInterval(refresh, 30000);
