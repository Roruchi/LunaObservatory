# LunaObs

LunaObs is a local-first CLI tool for observing coding-agent session traces.

> Luna is the moon. The moon does not generate the light. It reveals reflected light in darkness.
>
> LunaObs does the same for coding-agent sessions. It does not control agents. It observes the reflected traces they leave behind: turns, tools, tokens, loops, hooks, verification gaps, and patterns that are easy to miss in raw logs.
>
> Scan maps the traces. Dream interprets the patterns.

## Modules

- Scan: deterministic local analyzer that discovers native Codex and Copilot session logs, filters them to the current repo, normalizes trace evidence, scores suspicious sessions, and writes Markdown plus HTML reports.
- Dream: offline evaluator for frozen Scan evidence. Humans usually trigger dream mode; agents execute the reusable LunaObs Dream skill to prepare packets, validate them, inspect the generated report, and summarize evidence-backed lessons.

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
lunaobs scan --source codex --logs ~/.codex/sessions --all-repos
lunaobs scan --source copilot --logs tests/fixtures --repo .
lunaobs report
lunaobs dream prepare --input .lunaobs --out .lunaobs/dream --top 5
lunaobs dream validate --input .lunaobs/dream --out .lunaobs/dream/report.md
lunaobs skill install --agent codex
lunaobs skill install --agent copilot
lunaobs skill install --agent claude
```

## Dream Mode

Dream mode has a strict evidence boundary:

- `scan` gathers evidence from native agent session traces.
- `dream prepare` freezes selected scan evidence into `dream-pack.json`.
- `dream validate` evaluates only that prepared packet and writes a compact decision report, a traceability appendix, an HTML view, and a machine-readable apply plan.

Dream validation must not inspect the live repository, run git, run tests, call external tools, or infer facts from files outside the prepared packet. Missing packet fields become low-confidence observations or missing-evidence notes.

Packet preparation groups eligible sessions as efficient successes, inefficient successes, or failed/risky outcomes. It prioritizes recent evidence, spreads representatives across normalized repository identities, and selects at most one risk-prioritized representative from each parent/child agent family. The frozen packet and report retain each selected session's end date so this choice is auditable. Sessions still marked in progress, including completed children of an active parent family, are not selected for Dream validation; aborted runs remain available to the failed/risky group.

Dream first segments sessions into task windows, then classifies each attempted change as `repository_code`, `repository_docs`, `external_state`, `local_state`, `automation_memory`, `generated_artifact`, `read_only`, or `unknown`. A missing-verification finding is eligible only when a task contains a successful state change, that change requires verification, and no fresh matching check appears after the final relevant change. Read-only work is never treated as missing repository verification; documentation, external-state, generated-artifact, and automation-memory work use their own proportionate checks.

Dream scores use `insufficient` when the frozen packet cannot support a category. In particular, unknown instruction status is not counted as compliance, and low-confidence task segmentation or change classification is routed to human review instead of becoming a high-confidence verification finding. Findings keep observations, interpretations, alternative explanations, recommended actions, apply targets, and evidence references separate.

Agent-facing instructions live in `src/skills/lunaobs-dream/SKILL.md` and can be installed with `lunaobs skill install --agent codex|copilot|claude|all`. The main `report.md` groups repeated patterns and labels reliable findings, possible false positives, guidance, and human-review items. `details.md` carries session/task traceability, while `apply-plan.json` gives a follow-up agent explicit action classes and targets without implying that every observation needs a repository-wide rule.

## What Scan Measures

Scan derives metrics from events present in each trace:

- Session identity and lifecycle: Codex child and subagent runs keep their own session ID, while the parent session ID and agent path are retained separately when available. Copied parent history is removed from forked child traces before metrics are calculated. Task-start, task-complete, and abort events produce `in_progress`, `completed`, `aborted`, or `unknown` lifecycle states.
- Task-normalized effort: tool requests and output tokens are reported per observed task as well as per session. This avoids treating a long multi-task session as directly equivalent to a single-task run.
- Verification closure: after the last successful detected edit, recognized test, build, lint, type-check, validation, and project-check commands are grouped by exact script and working directory. The final states of every fresh lane produce `passed`, `failed`, `missing`, or `not_applicable` closure.
- Failure and recovery behavior: repeated-failure metrics count retries of the same canonical failing command, rather than adding unrelated failures together. Dream can distinguish an unresolved failed verification lane from a later pass in that lane.
- Redundant work: exact repeated read, search, glob, or command calls are counted only while the detected edit state is unchanged. Failed calls are excluded from this redundancy metric.

These are trace-derived indicators. They help locate sessions worth inspecting; they do not prove that the agent understood the task or that the resulting code is correct.

## Default Source Discovery

- Copilot: `COPILOT_HOME` or `~/.copilot`, using `session-state/*/events.jsonl`.
- Codex: `CODEX_HOME` or `~/.codex`, using `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`. The normalizer handles native Codex session metadata, turn context, lifecycle events, response items, tool calls, and cumulative token samples.
- Claude: `~/.claude`, using generic JSONL discovery. Claude-specific event normalization is not yet first-class.

Codex and Copilot traces are supported natively. Unknown or incomplete event fields remain explicit rather than being guessed.

## Repo Filtering

`lunaobs scan` detects the current repo with `git rev-parse --show-toplevel`, falling back to `process.cwd()`.

Sessions are included when hook `cwd` is inside the repo or when tool path arguments mostly point inside the repo. Unclear sessions are marked ambiguous. Clearly unrelated sessions are excluded. Use `--all-repos` to disable filtering while preserving the repository observed in each trace. Git worktree pointers resolve to their shared repository; deleted Codex worktrees are also collapsed when the same scan contains one unambiguous durable root with the same repository name.

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
    inefficiency-report.html
  dream/
    dream-pack.json
    dream-pack.md
    DREAM_TASK.md
    report.md
    report.html
    details.md
    apply-plan.json
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

LunaObs is still a small v0 evidence analyzer, not a task benchmark or semantic judge.

- Outcome scores combine observable lifecycle, edits, final-answer presence, and verification closure. They are prioritization signals, not proof of task completion or code quality.
- Per-task metrics use observed task-start events or normalized turns. They do not account for task difficulty, so comparisons across unrelated tasks and repositories remain directional.
- Verification recognition is deliberately conservative and command-based. Compound orchestration calls are expanded when their nested tools are visible, but a single compound result may still lack per-operation status detail. LunaObs cannot determine whether a test suite is adequate, whether a manual check happened, or whether an external system accepted the result.
- Redundancy detection recognizes exact canonical tool calls within an unchanged edit state. It can miss semantically equivalent calls, and an intentional fresh read may still need human interpretation.
- Instruction and claim checks depend on text and evidence captured in the trace. Missing or ambiguous evidence yields `insufficient` or `unknown`, not a positive score.
- Token fields, changed-file and changed-line counts, AI credits, and estimated cost depend on what the source trace exposes. Unsupported values remain unavailable rather than being estimated.
- Claude JSONL discovery exists, but Claude-specific normalization and validation still need implementation and real-session coverage.
