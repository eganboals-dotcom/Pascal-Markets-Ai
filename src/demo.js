import { readFileSync } from 'node:fs';
import { projectPath, writeProjectFile } from './files.js';
import { train } from './model.js';
import { replay } from './replay.js';

// Deliberately artificial games exercise the pipeline without implying a trading edge.
export function demoRows() {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const rows = [];
  for (let game = 0; game < 12; game++) {
    const gameId = `synthetic-nba-${game}`;
    const gameStart = start + game * 86400000;
    const homeWon = game % 2;
    for (let observation = 0; observation < 2; observation++) {
      const observedAt = gameStart + observation * 3000;
      const ask = game % 4 === 0 && observation === 1 ? 0.85 : 0.4;
      rows.push({
        synthetic: true, gameId, observedAt, resolvedAt: gameStart + 3600000,
        homeScore: homeWon ? 80 : 70, awayScore: homeWon ? 70 : 80,
        secondsRemaining: 600 - observation * 3, pregameHomeProbability: 0.5, homeWon,
        quote: {
          gameId, assetId: `synthetic-home-${game}`, sourceAt: observedAt, receivedAt: observedAt,
          ask, askSize: 100, outcome: 'home', marketType: 'moneyline',
          includesOvertime: true, acceptingOrders: true, secondsDelay: 3
        },
        sportsbook: {
          gameId, sourceAt: observedAt, receivedAt: observedAt,
          homeOdds: 1.5, awayOdds: 3, format: 'decimal',
          marketType: 'moneyline', includesOvertime: true, suspended: false
        }
      });
    }
  }
  return rows;
}

export function runDemo() {
  const cutoff = Date.parse('2026-10-09T00:00:00Z');
  const rows = demoRows();
  const holdout = rows.filter(row => row.observedAt >= cutoff);
  const { model, evaluation } = train(rows, cutoff);
  const sportsbookConfig = JSON.parse(readFileSync(projectPath('config/paper.json'), 'utf8'));
  const modelConfig = { ...sportsbookConfig, signal: 'model' };
  const report = {
    synthetic: true,
    purpose: 'Pipeline demonstration using artificial NBA observations. These results do not measure a real trading advantage.',
    trainingGames: model.trainingGames.length,
    evaluation,
    sportsbookReplay: replay(holdout, null, sportsbookConfig),
    modelReplay: replay(holdout, model, modelConfig)
  };
  const files = {
    'observations.jsonl': rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'holdout.jsonl': holdout.map(row => JSON.stringify(row)).join('\n') + '\n',
    'model.json': JSON.stringify(model, null, 2),
    'model-config.json': JSON.stringify(modelConfig, null, 2),
    'report.json': JSON.stringify(report, null, 2)
  };
  for (const [name, content] of Object.entries(files)) {
    writeProjectFile(`data/demo/${name}`, content);
  }
  return { ...report, outputDirectory: projectPath('data/demo') };
}
