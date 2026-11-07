import { readResearch, resultsReport, reportMarkdown } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';

const out = process.argv[2] ?? 'research/kalshi';
const report = resultsReport(readResearch(`${out}/log.jsonl`, [], true), readResearch(`${out}/dryrun.jsonl`, [], true), readResearch(`${out}/state.json`, {}));
writeProjectFile(`${out}/report.md`, reportMarkdown(report));
writeProjectFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
