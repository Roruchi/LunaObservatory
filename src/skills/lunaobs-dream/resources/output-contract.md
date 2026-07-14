# LunaObs Dream Output Contract

Dream validation writes a Markdown report from a prepared `dream-pack.json`.

Default flow:

```bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
```

Every finding needs severity, category, explanation, evidence references, confidence, and a suggested improvement.

The generated report must clearly separate evidence-backed findings, low-confidence observations, missing evidence, and recommendations.

The report must list inspected sessions and include concrete follow-up targets such as `AGENTS.md`, a skill file, a runbook, scan capture fields, or validation tooling. A follow-up apply agent should be able to act from the recommendations without guessing.
