import fs from "node:fs";
import { z } from "zod";
import type { RawLogEvent } from "../normalize/types.js";

const RawEventSchema = z.object({
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  type: z.string(),
  timestamp: z.string(),
  data: z.unknown().optional(),
  payload: z.unknown().optional()
});

export type JsonlReadResult = {
  events: RawLogEvent[];
  parseErrors: number;
  lines: number;
};

export function readJsonl(file: string): JsonlReadResult {
  const text = fs.readFileSync(file, "utf8");
  const events: RawLogEvent[] = [];
  let parseErrors = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = RawEventSchema.parse(JSON.parse(line));
      events.push({
        id: parsed.id ?? `${file}:${index + 1}`,
        parentId: parsed.parentId ?? undefined,
        type: parsed.type,
        timestamp: parsed.timestamp,
        data: parsed.data ?? parsed.payload ?? null,
        sourceFile: file,
        lineNumber: index + 1
      });
    } catch {
      parseErrors += 1;
    }
  });
  return { events, parseErrors, lines: lines.length };
}

export function writeJsonl(file: string, records: unknown[]): void {
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
}

export function readJsonlObjects<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
