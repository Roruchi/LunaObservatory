# LunaObs Dream Output Contract

Dream validation writes four decision artifacts from a prepared `dream-pack.json`:

- `report.md`: compact grouped human decision report
- `report.html`: readable HTML equivalent
- `details.md`: session/task traceability appendix
- `apply-plan.json`: machine-readable follow-up plan

Default flow:

```bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
```

Every finding needs a stable finding ID and pattern key, severity, category, disposition, task identity, observation, interpretation, alternative explanation, recommended action, apply target, confidence, and evidence references. Observed facts and inferred interpretation must remain separate.

The generated report must clearly label reliable findings, possible false positives, guidance, and human-review items. Repeated findings should be grouped by pattern, with the full per-session evidence retained in `details.md`.

Missing-verification findings are eligible only for task-local successful state changes that require verification and have no fresh matching check after the final relevant change. Read-only work is ineligible. Unknown or low-confidence classification must not become a high-confidence gap.

The apply plan must choose one proportional action class: `safe_guidance_update`, `analyzer_improvement`, `repository_specific_investigation`, `no_action`, or `human_review_required`. It must name exact targets and evidence so a follow-up agent can act without guessing, while avoiding durable policy from isolated low-confidence observations.
