# Session-to-attempt correlation

Build with `npm run build`, then run locally:

```sh
node dist/cli.js correlate --logs /fictional/traces --tasks /fictional/task-records.json --out /fictional/correlation.json
```

There is no network access or automatic Firstmate home discovery. The caller supplies a JSON array of task records exported or curated from verifiable Firstmate records. See `tests/fixtures/correlation-tasks.json` for a fully fictional example. Required fields are `taskId`, `attemptId` (nullable), `project`, `harness` (`claude`, `codex`, `copilot`), `spawnGeneration` (nullable), `startedAt`, `endedAt` (nullable), and `provenance: {uri, digest}`. Optional fields are `branchName`, `worktreePath`, and `steeringInboxPath`. Invalid records and reversed task windows are rejected. Digests identify supplied evidence; this tool cannot authenticate an export or independently validate a caller's claim of provenance.

A matched session requires one unique compatible record with a known attempt ID, a complete overlapping session/attempt time window, the same harness, and at least one task identity anchor:

- An exact native branch `fm/<taskId>` (a supplied branchName must agree).
- An exact steering inbox path in the first user instruction, delimited as a path token.
- An explicit `Task id: <taskId>` or `endpoint_task_id=<taskId>` line in that instruction.

An exact worktree path supports a match and raises confidence from medium to high. Paths normalize slash direction and trailing slashes only; no basename, case folding, symlink, substring, or nearest-time matching is used. Path plus time alone remains ambiguous at low confidence. Conflicting task branches, explicit task anchors, known inbox anchors, worktree paths, harnesses or nonoverlapping times exclude a record. Missing attempt identity or incomplete time windows leave candidates ambiguous; neither an attempt nor an end time is invented. Overlapping retries remain ambiguous even if one has more supporting evidence. No candidates means unmatched, with no task/attempt assigned.

Claude uses retained native metadata. Codex also reads session metadata (`git.branch`, `cwd`) and the first user message; copied-parent child headers are excluded. Copilot can use normalized cwd and the first native user message; missing branches remain unknown. Session context and headers are evidence, not arbitrary assistant claims or tool output. The first instruction is used as supplied; if it contains only bootstrap context, later messages are not searched for a convenient identity anchor.

`sessionCorrelation/1` includes task-file SHA-256, per-session trace SHA-256, parse error counts, candidates with original record indexes, evidence kinds, unknowns, confidence and reasons. Exact duplicate task records and byte-identical session copies are counted once. Different files sharing a source/session identity become ambiguous (`conflicting_session_copies`) instead of being concatenated or double counted. Multiple sessions may map to the same task/attempt; one session maps to at most one attempt. No acceptance, scoring, or token allocation is performed.

`evaluationIdentity(result, refId)` supplies the slice 1 input's identity shape: only matched attempts become known; mission, worker, role and model remain unknown. The caller must register `refId` in the evaluation packet provenance, referencing this correlation artifact and its digest. Task/project/spawn metadata remains in correlation candidates for auditing; a task is not automatically a workpackage, and no workpackage acceptance evidence is created. Keep one identity per unique session, and retain slice 1's existing criterion/revision rollup deduplication. Never sum shared accepted outcomes or assume child traces and parent usage represent disjoint measured effort. Real-session evaluation and adjudication belong to a later slice.

The command writes only the requested JSON file and prints counts. Keep real task exports and correlation artifacts outside public repositories. Its synthetic tests cover accepted, ambiguous, unmatched, duplicate-streaming, missing-usage and multiple-session cases. Reproduce checks with `npm run build` and `npm test`; this repository currently defines no lint script or CI workflow.

Claude correlation entries include `coverage` for history, usage, inherited-event counts, unresolved inherited events and allocation notes. See the [Claude adapter](claude-adapter.md) for the shared Scan/correlation deduplication rule, coverage semantics and accepted undercounts.
