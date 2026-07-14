import type { NormalizedSession, SessionClassification } from "../normalize/types.js";
import type { InefficiencyScore } from "../scoring/score.js";
import { buildScanReportModel, type RankedSessionRow, type ScanSummary } from "./scanModel.js";

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function label(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scoreLevel(score: number): "low" | "medium" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function metricCard(labelText: string, value: number | string, note: string): string {
  return `<section class="metric-card"><span>${escapeHtml(labelText)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></section>`;
}

function classificationBar(name: SessionClassification, count: number, total: number): string {
  const width = total === 0 ? 0 : Math.max(2, Math.round((count / total) * 100));
  return `
          <div class="class-row">
            <div class="class-label">
              <span>${escapeHtml(label(name))}</span>
              <strong>${count}</strong>
            </div>
            <div class="bar-track" aria-hidden="true">
              <div class="bar-fill ${name}" style="width: ${width}%"></div>
            </div>
          </div>`;
}

function sessionArticle(row: RankedSessionRow): string {
  const reasons = row.reasons.length
    ? row.reasons.map((reason) => `<span class="reason">${escapeHtml(reason)}</span>`).join("")
    : `<span class="reason muted">No reason codes</span>`;
  const level = scoreLevel(row.score);
  return `
        <article class="session-card ${level}">
          <div class="session-rank">${row.rank}</div>
          <div class="session-main">
            <div class="session-title">
              <h3>${escapeHtml(row.sessionId)}</h3>
              <span class="pill ${row.classification}">${escapeHtml(label(row.classification))}</span>
            </div>
            <div class="score-line">
              <strong>${row.score}</strong>
              <div class="score-track" aria-label="Inefficiency score ${row.score} of 100">
                <div style="width: ${Math.max(1, Math.min(100, row.score))}%"></div>
              </div>
              <span>Outcome ${row.outcomeScore}</span>
            </div>
            <dl class="session-stats">
              <div><dt>Models</dt><dd>${escapeHtml(row.models)}</dd></div>
              <div><dt>Turns</dt><dd>${row.turns}</dd></div>
              <div><dt>Output tokens</dt><dd>${escapeHtml(row.outputTokens)}</dd></div>
              <div><dt>Tool calls</dt><dd>${row.toolCalls}</dd></div>
              <div><dt>Repeated views</dt><dd>${row.repeatedFileViews}</dd></div>
              <div><dt>Verification</dt><dd>${row.verificationEvents}</dd></div>
            </dl>
            <div class="reasons">${reasons}</div>
          </div>
        </article>`;
}

export function generateScanHtmlReport(
  sessions: NormalizedSession[],
  scores: InefficiencyScore[],
  summary: ScanSummary,
  top = 5
): string {
  const model = buildScanReportModel(sessions, scores, summary, top);
  const totalScores = Object.values(model.counts).reduce((sum, count) => sum + count, 0);
  const suspiciousTotal = model.counts.suspicious + model.counts.inefficient;
  const css = `
    :root {
      color-scheme: light;
      --bg: #f7f5ef;
      --surface: #fffdf8;
      --surface-strong: #ffffff;
      --ink: #222831;
      --muted: #67707c;
      --line: #ded8cc;
      --green: #28745a;
      --blue: #3568b8;
      --amber: #b56812;
      --red: #b33c32;
      --violet: #7752a8;
      --shadow: 0 18px 45px rgba(34, 40, 49, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(135deg, rgba(53, 104, 184, 0.10), transparent 42%),
        linear-gradient(315deg, rgba(40, 116, 90, 0.12), transparent 38%),
        var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      margin-bottom: 24px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(2rem, 4vw, 4.4rem); line-height: 0.95; max-width: 780px; }
    h2 { font-size: 1.1rem; margin-bottom: 14px; }
    h3 { font-size: 0.98rem; overflow-wrap: anywhere; }
    .eyebrow { color: var(--blue); font-weight: 750; letter-spacing: 0; text-transform: uppercase; font-size: 0.78rem; margin-bottom: 10px; }
    .subtitle { max-width: 720px; color: var(--muted); margin-top: 16px; font-size: 1rem; }
    .generated {
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
      min-width: 240px;
      box-shadow: 0 8px 24px rgba(34, 40, 49, 0.06);
    }
    .generated span, .metric-card span, dt { display: block; color: var(--muted); font-size: 0.78rem; }
    .generated strong, dd { font-weight: 750; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0;
    }
    .metric-card, .panel, .session-card {
      background: rgba(255, 253, 248, 0.88);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 10px 28px rgba(34, 40, 49, 0.07);
    }
    .metric-card { padding: 14px; min-height: 118px; }
    .metric-card strong { display: block; font-size: 2rem; line-height: 1.1; margin: 8px 0; }
    .metric-card small { color: var(--muted); }
    .dashboard {
      display: grid;
      grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
      gap: 16px;
      align-items: start;
    }
    .panel { padding: 18px; overflow: hidden; }
    .class-row + .class-row { margin-top: 14px; }
    .class-label { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-size: 0.9rem; }
    .bar-track, .score-track {
      height: 10px;
      border-radius: 999px;
      background: #ece7dd;
      overflow: hidden;
    }
    .bar-fill, .score-track div { height: 100%; border-radius: inherit; }
    .efficient { background: var(--green); }
    .expensive_but_justified { background: var(--blue); }
    .suspicious { background: var(--amber); }
    .inefficient { background: var(--red); }
    .unknown { background: var(--violet); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      color: var(--muted);
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0;
      border-bottom: 1px solid var(--line);
      padding: 0 10px 10px 0;
    }
    td { border-bottom: 1px solid #eee8dc; padding: 10px 10px 10px 0; vertical-align: top; }
    td.numeric, th.numeric { text-align: right; }
    code { font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; font-size: 0.82rem; color: #425064; overflow-wrap: anywhere; }
    .top-sessions { margin-top: 16px; }
    .session-card {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      gap: 14px;
      padding: 16px;
      margin-bottom: 12px;
      background: var(--surface-strong);
    }
    .session-card.high { border-left: 5px solid var(--red); }
    .session-card.medium { border-left: 5px solid var(--amber); }
    .session-card.low { border-left: 5px solid var(--blue); }
    .session-rank {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: #222831;
      color: white;
      font-weight: 800;
    }
    .session-title, .score-line {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .score-line { margin: 10px 0 12px; }
    .score-line strong { font-size: 1.45rem; }
    .score-track { flex: 1 1 180px; min-width: 150px; }
    .score-track div { background: linear-gradient(90deg, var(--blue), var(--amber), var(--red)); }
    .score-line span { color: var(--muted); font-size: 0.86rem; }
    .pill, .reason {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 0.76rem;
      font-weight: 750;
      color: white;
    }
    .reason {
      color: #35404d;
      background: #f0ebe1;
      border: 1px solid #e0d8ca;
      margin: 4px 6px 0 0;
    }
    .reason.muted { color: var(--muted); }
    .session-stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
    }
    .session-stats div {
      background: #faf7ef;
      border: 1px solid #ece4d6;
      border-radius: 8px;
      padding: 9px;
      min-width: 0;
    }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .section-stack { display: grid; gap: 16px; margin-top: 16px; }
    .empty { color: var(--muted); padding: 8px 0; }
    .reason-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .reason-count {
      background: #fffaf0;
      border: 1px solid #eadcc5;
      border-radius: 999px;
      padding: 7px 10px;
      font-size: 0.84rem;
    }
    @media (max-width: 900px) {
      header, .dashboard { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .session-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 20px, 1180px); padding-top: 18px; }
      .metric-grid, .session-stats { grid-template-columns: 1fr; }
      .session-card { grid-template-columns: 1fr; }
      .session-rank { width: 34px; height: 34px; }
      table { min-width: 680px; }
      .table-scroll { overflow-x: auto; }
    }
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LunaObs Scan Report</title>
  <style>${css}</style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">LunaObs Scan</p>
        <h1>Session Inefficiency Report</h1>
        <p class="subtitle">A local summary of scanned agent sessions, suspicious patterns, repository spread, and telemetry coverage.</p>
      </div>
      <aside class="generated">
        <span>Generated at</span>
        <strong>${escapeHtml(model.summary.generatedAt)}</strong>
      </aside>
    </header>

    <section class="metric-grid" aria-label="Scan summary">
      ${metricCard("Files scanned", model.summary.filesScanned, `${model.summary.eventsParsed} events parsed`)}
      ${metricCard("Sessions found", model.sessionsFound, `${model.includedSessions} included, ${model.ambiguousSessions} ambiguous`)}
      ${metricCard("Suspicious sessions", suspiciousTotal, `${model.counts.suspicious} suspicious, ${model.counts.inefficient} inefficient`)}
      ${metricCard("Parse errors", model.summary.parseErrors, `${model.excludedSessions} sessions excluded`)}
    </section>

    <section class="dashboard">
      <div class="panel">
        <h2>Classification Counts</h2>
        ${classificationBar("efficient", model.counts.efficient, totalScores)}
        ${classificationBar("expensive_but_justified", model.counts.expensive_but_justified, totalScores)}
        ${classificationBar("suspicious", model.counts.suspicious, totalScores)}
        ${classificationBar("inefficient", model.counts.inefficient, totalScores)}
        ${classificationBar("unknown", model.counts.unknown, totalScores)}
      </div>

      <div class="panel">
        <h2>Repositories</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th class="numeric">Sessions</th>
                <th class="numeric">Suspicious</th>
                <th class="numeric">Max score</th>
                <th class="numeric">Tool calls</th>
                <th class="numeric">Verification</th>
                <th>Example path</th>
              </tr>
            </thead>
            <tbody>
              ${
                model.repositories.length
                  ? model.repositories
                      .map(
                        (row) => `<tr>
                <td><strong>${escapeHtml(row.name)}</strong></td>
                <td class="numeric">${row.sessions}</td>
                <td class="numeric">${row.suspicious}</td>
                <td class="numeric">${row.maxScore}</td>
                <td class="numeric">${row.toolCalls}</td>
                <td class="numeric">${row.verificationEvents}</td>
                <td><code>${escapeHtml(row.examplePath)}</code></td>
              </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="7" class="empty">No repositories found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="section-stack">
      <div class="panel">
        <h2>Top Suspicious Sessions</h2>
        <div class="top-sessions">
          ${
            model.rankedSessions.length
              ? model.rankedSessions.map((row) => sessionArticle(row)).join("")
              : `<p class="empty">No suspicious sessions selected.</p>`
          }
        </div>
      </div>

      <div class="dashboard">
        <div class="panel">
          <h2>Repeated Patterns</h2>
          <div class="reason-grid">
            ${
              model.reasonCounts.length
                ? model.reasonCounts.map((row) => `<span class="reason-count">${escapeHtml(row.reason)}: <strong>${row.count}</strong></span>`).join("")
                : `<p class="empty">No repeated reason codes found.</p>`
            }
          </div>
        </div>

        <div class="panel">
          <h2>Telemetry Coverage</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th class="numeric">Reported</th>
                  <th class="numeric">Unavailable</th>
                </tr>
              </thead>
              <tbody>
                ${model.telemetryCoverage
                  .map(
                    (row) => `<tr>
                  <td>${escapeHtml(row.metric)}</td>
                  <td class="numeric">${row.reported}</td>
                  <td class="numeric">${row.unavailable}</td>
                </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>
`;
}
