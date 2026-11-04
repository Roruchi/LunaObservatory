# Session-to-attempt correlation

Build with `npm run build`, then run locally:

```sh
node dist/cli.js correlate --logs /fictional/traces --tasks /fictional/task-records.json --out /fictional/correlation.json
```

There is no network access or automatic Firstmate home discovery. The caller supplies a JSON array of task records exported or curated from verifiable Firstmate records. The authoritative [task record schemas](../src/correlation/index.ts) define required and optional fields, nullability and validation; see [the fictional task records](../tests/fixtures/correlation-tasks.json) for an example. Invalid records and reversed task windows are rejected. Digests identify supplied evidence; this tool cannot authenticate an export or independently validate a caller's claim of provenance.

A matched session requires a recorded native session identity and one unique compatible record with a known attempt ID, a complete overlapping session/attempt time window, the same harness, and at least one task identity anchor:

- An exact caller-retained `nativeSessionId` matching the same harness’s native session identity. When supplied, a different or missing native identity excludes that record, even if another anchor agrees.
- An exact native branch `fm/<taskId>` (a supplied branchName must agree).
- An exact steering inbox path in the first user instruction, delimited as a path token.
- An explicit `Task id: <taskId>` or `endpoint_task_id=<taskId>` line in that instruction.

An exact worktree path supports a match and raises confidence from medium to high. Paths normalize slash direction and trailing slashes only; no basename, case folding, symlink, substring, or nearest-time matching is used. Path plus time alone remains ambiguous at low confidence. Conflicting task branches, explicit task anchors, known inbox anchors, worktree paths, harnesses or nonoverlapping times exclude a record. Missing attempt identity or incomplete time windows leave candidates ambiguous; neither an attempt nor an end time is invented. Overlapping retries remain ambiguous even if one has more supporting evidence. No candidates means unmatched, with no task/attempt assigned.

Claude uses retained native metadata. Codex also reads session metadata (`git.branch`, `cwd`) and the first user message; copied-parent child headers are excluded. Copilot can use normalized cwd and the first native user message; missing branches remain unknown. Session context and headers are evidence, not arbitrary assistant claims or tool output. The first instruction is used as supplied; if it contains only bootstrap context, later messages are not searched for a convenient identity anchor.

`sessionCorrelation/1` includes task-file SHA-256, per-session trace SHA-256, parse error counts, candidates with original record indexes, evidence kinds, unknowns, confidence and reasons. Exact duplicate task records and byte-identical session copies are counted once. Different files sharing a source/session identity become ambiguous (`conflicting_session_copies`) without verified task/attempt attribution. Claude copies share the adapter’s single normalized session and request deduplication policy. Multiple sessions may map to the same task/attempt; one session maps to at most one attempt. No acceptance, scoring, or token allocation is performed.

`evaluationIdentity(result, refId)` supplies the slice 1 input's identity shape: only matched attempts become known; file-derived IDs for Claude, Codex and Copilot remain unknown native session identities (`session_id_missing`), even with an exact branch and overlapping time; mission, worker, role and model remain unknown. The caller must register `refId` in the evaluation packet provenance, referencing this correlation artifact and its digest. Task/project/spawn metadata remains in correlation candidates for auditing; a task is not automatically a workpackage, and no workpackage acceptance evidence is created. Keep one identity per unique session, and retain slice 1's existing criterion/revision rollup deduplication. Never sum shared accepted outcomes or assume child traces and parent usage represent disjoint measured effort. Real-session evaluation and adjudication belong to a later slice.

The command writes only the requested JSON file and prints counts. Keep real task exports and correlation artifacts outside public repositories. Its synthetic tests cover accepted, ambiguous, unmatched, duplicate-streaming, missing-usage and multiple-session cases. Reproduce checks with `npm run build` and `npm test`; this repository currently defines no lint script or CI workflow.

Claude correlation entries include `coverage` for history, usage, inherited-event counts, unresolved inherited events and allocation notes. See the [Claude adapter](claude-adapter.md) for the shared Scan/correlation deduplication rule, coverage semantics and accepted undercounts.

Normalized sessions retain `nativeSessionId` separately from the display/session key: a native ID when recorded, otherwise null. Correlation uses this property to preserve identity uncertainty, including when there are no candidates.

## Durable spawn records

LunaObservatory reads traces and caller exports; it does not launch Firstmate workers. The Firstmate spawn integration must write a durable record per task **and per attempt**, outside ephemeral endpoint metadata, and retain it after cleanup. No spawn or Firstmate repository code is changed here.

At spawn, persist: `taskId`, a unique immutable `attemptId`, `project`, `harness` (`codex`, `claude`, `copilot`), `spawnGeneration`, exact `branchName`, `worktreePath`, `steeringInboxPath`, and `startedAt` (actual spawn timestamp, ISO 8601 with timezone). Record `nativeSessionId` from the harness launch receipt, never by searching prose or choosing a nearby trace. If the ID is available only after launch, atomically update that same attempt record when the receipt arrives; keep it null until then. Preserve the distinction between a native session ID and an orchestrator attempt ID. Record continuations/retries as their own attempts with their own native IDs, retaining the parent relationship in the launcher record rather than overwriting the previous attempt.

Initially `endedAt` is null. Update it from actual attempt completion, not task cleanup. Export `provenance.uri` and a digest of the retained source record. Keep administrative task dispatch/cleanup windows separately: they are not attempt windows. Export the full known task/attempt inventory when testing uniqueness. The optional `nativeSessionId` field is backward compatible with existing exports; omitting it does not upgrade historical candidates. Missing attempt ID, incomplete windows or contradictory anchors still prevent a match. A caller-supplied digest identifies evidence but does not authenticate the launcher.

## Per-worker report cards

```sh
node dist/cli.js report-card --source all --logs /fictional/traces --tasks /fictional/task-records.json --out /fictional/worker-report-cards.md
```

This local command emits one card for every candidate/matched worker session under each supplied task, plus separately labelled native execution parents and explicit unknown cards for tasks without compatible sessions. Shared sessions may appear under multiple candidate tasks; these are alternatives, not independent attempts. Parent links do not create task identity. The output includes task association, verified attempt or unknown, harness/model, observed native wall duration, native tool counts, direct/expanded edits, command and verification counts, post-edit closure, lifecycle, correlation reasons/confidence and trace provenance. It never copies transcript prose, shell commands or tool results.

Every quality outcome is **Unscored / low confidence** because this command has no adjudicated acceptance packet or comparable effort baseline. Inefficiency is described with plain trace findings and counts rather than an unsupported quality number. Recognized command success is a trace observation, not independent acceptance. Checks and edits through unrecognized shell programs remain unknown; parent and child counts and durations must not be summed. Conflicting copies stay ambiguous. Codex and Copilot activity comes from the first discovered copy, as in Scan; Claude copies follow the [adapter’s merge and deduplication rules](claude-adapter.md). Live trace reads are not an atomic corpus snapshot.

Session scoring version 4 emits null outcome/inefficiency scores, `evidenceStatus: "unscored"`, low confidence and an unknown classification when no native tool evidence is recorded, even if a final answer exists. Other session scores remain explicitly labelled low-confidence heuristics, not workpackage quality. Rebuild and rescan to replace old version 3 cached scores. Unscored sessions do not enter Dream’s score-based representative selection.

## Command evidence

Command semantics recognize `command` and `cmd`, including retained argument envelopes and bounded literal nested `tools.exec_command` calls. Static double/single-quoted and noninterpolated template literals are decoded without evaluating code; dynamic command expressions are unknown and cannot establish duplicate commands. Command completion requires authoritative execution metadata, not status-like text in stdout. For supported nested wrappers, only retained whole-result envelopes tied to printed calls establish command status; printing only `r.output` or omitting the result leaves verification unresolved. Native wrapper failure headers are recognized in both string and content-block array outputs. Session-linked `write_stdin` completions resolve the originating `exec_command`, including chained polls and separate wrappers, without assigning outcomes to sibling commands or making a pre-edit check fresh. Partial command results remain unresolved verification evidence.

Scan verification closure requires checks after the last successful edit in each evidenced execution scope. Every edit target must resolve inside that scope; missing targets or execution context cannot inherit another scope's verification. Dream retains scope and resolved targets in the frozen packet and matches checks after the final relevant change. Neither consumer treats a shared repository basename as evidence of matching execution scope.

Verification lanes distinguish the canonical command, working directory and extracted environment assignments. Assignment names and known literal values retain their case, with names sorted for stable identity; command recognition uses the body after supported prefixes. For example, a passing `TEST_SUITE=integration npm test` cannot clear a failed `TEST_SUITE=unit npm test`, and the two calls are not duplicates. Unresolved assignment values remain opaque and keep executions distinct, so they cannot establish recovery or duplicates. Scan and Dream use the same lane identity; see the [identity regressions](../tests/toolSemantics.test.ts) and [frozen Dream regressions](../tests/dreamRepositoryVerification.test.ts).

Worker cards expose known/unknown command bodies, execution contexts, assignment values and edit-target extraction counts without printing their payloads.
