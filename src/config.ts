import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const projectSchema = z.object({
  name: z.string().min(1, "project name is required"),
  path: z.string().min(1, "project path is required"),
  packageManager: z.string().optional(),
  tscCommand: z.string().min(1, "tscCommand is required"),
});

const configSchema = z.object({
  workspaceDir: z.string().min(1, "workspaceDir is required"),
  timeoutSec: z.number().int().positive("timeoutSec must be > 0"),
  projects: z.array(projectSchema),
});

export type ProjectConfig = z.infer<typeof projectSchema>;
export type Config = z.infer<typeof configSchema>;

export interface ResolvedConfig extends Config {
  workspaceDir: string;
}

export async function readConfig(configPath: string): Promise<ResolvedConfig> {
  const resolvedPath = path.resolve(configPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error reading config";
    throw new Error(`Failed to read config at ${resolvedPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in config at ${resolvedPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config shape: ${details}`);
  }

  const baseDir = path.dirname(resolvedPath);
  const workspaceDir = path.resolve(baseDir, result.data.workspaceDir);

  return {
    ...result.data,
    workspaceDir,
  };
}

