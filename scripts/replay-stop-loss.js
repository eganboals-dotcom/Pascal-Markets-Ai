import { readFileSync } from 'node:fs';
import { jsonLines } from '../src/history.js';
import { kalshiFee } from '../src/kalshi.js';
import { projectPath, writeProjectFile } from '../src/files.js';
const root = process.argv[2] ?? 'work/agent-sample';
const report = JSON.parse(readFileSync(projectPath(`${root}/agents/game-watch-report.json`), 'utf8'));
const trades = report.trades.filter(t => Number.isFinite(t.bookTime));
const wanted = new Set(trades.map(t => t.ticker)), books = new Map();
for (const day of [...new Set(trades.map(t => t.day))]) {
  for await (const b of jsonLines(`${root}/${day}/books.jsonl`)) if (wanted.has(b.ticker)) {
    if (!books.has(b.ticker)) books.set(b.ticker, []);
    books.get(b.ticker).push(b);
  }
}
for (const rows of books.values()) rows.sort((a,b) => a.time - b.time);
const rules = [{ type: 'hold', level: null }, ...[0.05,0.1,0.2,0.3,0.5].map(level => ({ type: 'drop', level })), ...[0.02,0.05,0.1].map(level => ({ type: 'floor', level }))];
const results = rules.map(rule => {
  let pnl = 0, exits = 0, winningPositionsCut = 0, wrongPositionsExited = 0;
  for (const t of trades) {
    let result = t.pnl;
    if (rule.type !== 'hold') for (const b of books.get(t.ticker) ?? []) {
      if (b.time <= t.bookTime) continue;
      const value = t.side === 'yes' ? b.yesBid : 1-b.yesAsk;
      if (!(value > 0 && value <= (rule.type === 'drop' ? t.price-rule.level : rule.level))) continue;
      result = value - kalshiFee(1, value, 0.07*(b.fee_multiplier ?? 1)) - t.price - t.fee;
      exits++; if (t.wrong) wrongPositionsExited++; else winningPositionsCut++;
      break;
    }
    pnl += result;
  }
  return {...rule, trades:trades.length, pnl, exits, winningPositionsCut, wrongPositionsExited};
});
const output = { generatedAt: Date.now(), source: `${root}/agents/game-watch-report.json`,
  limitations: ['One-contract candle replay; no depth, queue or fill guarantee.', 'Corrected feed revisions and live settlement arrival times are not recorded. Thesis exits and 24-hour breakers cannot be faithfully backtested from this sample.'], results };
writeProjectFile('outputs/stop-loss-replay.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
