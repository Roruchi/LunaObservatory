import { z } from "zod";

export const ConfigSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  sources: z.array(z.enum(["copilot", "codex", "claude"]))
});

export type LunaObsConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): LunaObsConfig {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sources: ["copilot", "codex", "claude"]
  };
}
