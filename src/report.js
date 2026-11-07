import { readFileSync } from 'node:fs';
import { projectPath } from './files.js';

export function readResearch(path, fallback, jsonl = false) {
  try {
    const text = readFileSync(projectPath(path), 'utf8');
    return jsonl ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text);
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function resultsReport(closed, dryrun, state, now = Date.now()) {
  // shortcut: legacy cross-venue logs lack start times, re-record public market metadata before retrospective in-play analysis.
  const hits = [...closed, ...Object.values(state.open ?? {}).map(h => ({ ...h, minDurationMs: h.lastSeen - h.firstSeen }))];
  const byKind = {}, bySeries = {}, durations = {}, outcomes = { filled: 0, legged: 0, missed: 0, skipped: 0 }, skipReasons = {};
  const startedGames = [];
  for (const hit of hits) {
    byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1;
    // shortcut: old logs infer the full series prefix from the event ticker, record explicit series on new scans.
    const series = hit.series ?? hit.event?.split('-')[0] ?? 'unknown';
    bySeries[series] = (bySeries[series] ?? 0) + 1;
    (durations[hit.id] ??= []).push(hit.minDurationMs ?? 0);
    if (hit.kind === 'cross-venue' && hit.legs?.some(l => Number.isFinite(l.gameStartAt) && l.gameStartAt <= (hit.lastSeen ?? now))) startedGames.push(hit.id);
  }
  const lifetime = Object.entries(durations).map(([id, values]) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return { id, medianMinDurationMs: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2, maxMinDurationMs: values.at(-1) };
  });
  for (const row of dryrun) {
    if (row.outcome in outcomes) outcomes[row.outcome]++;
    if (row.outcome === 'skipped') skipReasons[row.reason ?? 'unknown'] = (skipReasons[row.reason ?? 'unknown'] ?? 0) + 1;
  }
  const today = new Date(now).toISOString().slice(0, 10);
  return { generatedAt: now, scannedAt: state.scannedAt ?? null,
    hitsToday: hits.filter(h => Number.isFinite(h.firstSeen) && new Date(h.firstSeen).toISOString().slice(0, 10) === today).length,
    byKind, bySeries, lifetime, outcomes, skipReasons, nearMissSummary: state.nearMissSummary ?? null, startedGames };
}

export const markdownTable = (headers, rows) => [
  `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(x => String(x).replaceAll('|', '/').replaceAll('\n', ' ')).join(' | ')} |`)
].join('\n');

export function reportMarkdown(report) {
  const counts = obj => markdownTable(['Category', 'Count'], Object.entries(obj));
  return ['# Kalshi results report', '', `Generated ${new Date(report.generatedAt).toISOString()}. Research only. Counts include closed and open hit episodes; today uses UTC.`, '',
    `Hits today: ${report.hitsToday}`, '', '## Hits by kind', '', counts(report.byKind), '', '## Hits by series prefix', '', counts(report.bySeries), '',
    '## Hit lifetimes', '', markdownTable(['Hit', 'Median minDurationMs', 'Maximum minDurationMs'], report.lifetime.map(h => [h.id, h.medianMinDurationMs, h.maxMinDurationMs])), '',
    '## Dry-run outcomes', '', counts(report.outcomes), '', '### Skip reasons', '', counts(report.skipReasons), '',
    '## Latest scan near misses (profit per basket contract)', '', report.nearMissSummary ? counts(report.nearMissSummary) : 'No scan summary recorded.', '',
    '## Cross-venue games already started at sighting', '', ...(report.startedGames.length ? report.startedGames.map(id => `- ${id}`) : ['None recorded.']), '',
    'Legacy cross-venue records without gameStartTime cannot be checked retrospectively.', ''].join('\n');
}
