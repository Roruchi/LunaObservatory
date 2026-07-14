export function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const started = Date.parse(start);
  const ended = Date.parse(end);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return undefined;
  return Math.max(0, ended - started);
}

export function minIso(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort()[0];
}

export function maxIso(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort().at(-1);
}
