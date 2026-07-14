# LunaObs Skills

LunaObs ships reusable agent-facing skills from this directory. `lunaobs skill install --agent <agent>` copies the relevant skill into the agent-specific skill location.

## lunaobs-dream

`src/skills/lunaobs-dream/SKILL.md` is the canonical Dream mode skill.

Use it when a human asks an agent to evaluate, review, judge, compare, or learn from one or more LunaObs-scanned agent sessions. The skill instructs the agent to run:

```bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
```

Dream mode evaluates frozen scan evidence. The agent may run the dream commands and read generated dream artifacts, but must not inspect the live repository, git history, tests, or external sources to fill evidence gaps.
