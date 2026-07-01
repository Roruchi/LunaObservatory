# LunaObs

LunaObs is a local-first CLI tool for observing coding-agent session traces.

> Luna is the moon. The moon does not generate the light. It reveals reflected light in darkness.
>
> LunaObs does the same for coding-agent sessions. It does not control agents. It observes the reflected traces they leave behind: turns, tools, tokens, loops, hooks, verification gaps, and patterns that are easy to miss in raw logs.
>
> Scan maps the traces. Dream interprets the patterns.

## Modules

- Scan: deterministic local analyzer that discovers native session logs, filters them to the current repo, parses metrics, scores suspicious sessions, and writes reports.
- Dream: agent skill scaffold for investigating the most suspicious Scan results and producing evidence-backed lessons and environment suggestions.

LunaObs reads native agent session files directly. It does not depend on TokenTelemetry exports.

## Install, Build, Test

```bash
npm install
npm test
npm run build
```

After building, run the CLI through npm linking or directly with Node:

```bash
node dist/cli.js init
node dist/cli.js scan
```

## CLI Examples

```bash
lunaobs init
lunaobs scan
lunaobs scan --source copilot --logs tests/fixtures --repo .
lunaobs report
lunaobs dream prepare --top 5
lunaobs dream validate
lunaobs skill install --agent codex
lunaobs skill install --agent copilot
lunaobs skill install --agent claude
```

## Default Source Discovery

- Copilot: `COPILOT_HOME` or `~/.copilot`, using `session-state/*/events.jsonl`.
- Codex: `CODEX_HOME` or `~/.codex`, using placeholder JSONL discovery.
- Claude: `~/.claude`, using placeholder JSONL discovery.

The first implemented parser supports Copilot-style JSONL events.

## Repo Filtering

`lunaobs scan` detects the current repo with `git rev-parse --show-toplevel`, falling back to `process.cwd()`.

Sessions are included when hook `cwd` is inside the repo or when tool path arguments mostly point inside the repo. Unclear sessions are marked ambiguous. Clearly unrelated sessions are excluded. Use `--all-repos` to disable filtering.

## Output Structure

```txt
.lunaobs/
  config.json
  index/
    discovered-sources.json
    repo-filter.json
    sessions.jsonl
    session-metrics.jsonl
    inefficiency-scores.jsonl
  reports/
    inefficiency-report.md
  dream/
    dream-pack.json
    dream-pack.md
    DREAM_TASK.md
    output/
  skills/
    lunaobs-dream/
      SKILL.md
      resources/
        output-contract.md
        investigation-rules.md
```

## Privacy

LunaObs does not copy raw `encryptedContent` or `reasoningOpaque` into reports. The scaffold records only boolean flags such as `hasEncryptedContent` and `hasOpaqueReasoning`, plus metrics and source references. It does not capture full chat transcripts.

## Limitations

This is a small v0 scaffold. Input tokens, cached tokens, AI credits, estimated cost, changed files, and changed lines are marked unavailable. Codex and Claude discovery are present as placeholders, while Copilot-style `events.jsonl` is the first supported parser.
