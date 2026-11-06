const number = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const setText = (id, value) => { document.getElementById(id).textContent = value; };

function table(headers, rows) {
  const element = document.createElement('table');
  const head = element.createTHead().insertRow();
  for (const title of headers) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = title;
    head.append(cell);
  }
  const body = element.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (const value of row) line.insertCell().textContent = value;
  }
  return element;
}

async function refresh() {
  const button = document.getElementById('refresh');
  button.disabled = true;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Status unavailable');
    const data = await response.json();
    setText('updated', `Checked ${new Date(data.checkedAt).toLocaleTimeString()}`);
    setText('project-path', data.projectRoot);
    const capture = data.captures[0];
    if (capture) {
      setText('market-count', number(capture.markets.length));
      const books = capture.summary?.streams?.find(stream => stream.source === 'books');
      setText('message-count', number(capture.analysis?.bookMessages ?? books?.count));
      setText('quote-count', number(capture.analysis?.reconstructedQuotes));
      setText('age', capture.analysis?.messageAgeMs ? `${number(capture.analysis.messageAgeMs.p95)} ms` : '—');
      setText('capture-state', capture.state);
      const detail = document.getElementById('capture-details');
      detail.replaceChildren(table(['Game', 'Scheduled start'], capture.markets.map(market => [market.title, new Date(market.startsAt).toLocaleString()])));
      const files = document.createElement('p');
      files.textContent = capture.files.map(file => `${file.name} · ${number(file.bytes / 1024)} KB`).join(' / ');
      detail.append(files);
    }
    if (data.demo) {
      const demo = document.getElementById('demo-details');
      demo.replaceChildren(table(['Synthetic experiment', 'Paper fills', 'Example net P&L', 'Fees'], [
        ['Sportsbook odds', number(data.demo.sportsbookReplay.fills), `$${number(data.demo.sportsbookReplay.netPnl)}`, `$${number(data.demo.sportsbookReplay.feesPaid)}`],
        ['Probability model', number(data.demo.modelReplay.fills), `$${number(data.demo.modelReplay.netPnl)}`, `$${number(data.demo.modelReplay.feesPaid)}`]
      ]));
      const evaluation = document.createElement('p');
      evaluation.textContent = `${data.demo.trainingGames} artificial training games · ${data.demo.evaluation.games} holdout games · Brier score ${data.demo.evaluation.brier.toFixed(4)}`;
      demo.append(evaluation);
    }
  } catch { setText('updated', 'Unable to load local status. Check that the dashboard process is running.'); }
  finally { button.disabled = false; }
}

document.getElementById('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 10000);
