import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ProjectConfig, ResolvedConfig } from "./config.js";

export interface ProjectOutcome {
  name: string;
  passed: boolean;
  logPath: string;
  reason?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
}

export interface RunPaths {
  runDir: string;
  logsDir: string;
}

interface RunnerOptions {
  config: ResolvedConfig;
  paths: RunPaths;
}

class HeadBuffer {
  private readonly maxLines: number;
  private lines: string[] = [];
  private leftover = "";

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  add(chunk: Buffer | string): void {
    if (this.lines.length >= this.maxLines) return;
    this.leftover += chunk.toString();
    const parts = this.leftover.split(/\r?\n/);
    this.leftover = parts.pop() ?? "";
    for (const line of parts) {
      if (this.lines.length >= this.maxLines) {
        this.leftover = "";
        return;
      }
      this.lines.push(line);
    }
  }

  value(): string {
    if (this.lines.length < this.maxLines && this.leftover.trim().length > 0) {
      return [...this.lines, this.leftover].slice(0, this.maxLines).join("\n");
    }
    return this.lines.slice(0, this.maxLines).join("\n");
  }
}

function sanitizeFileName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length ? sanitized : "project";
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function resolveProjectPath(workspaceDir: string, projectPath: string): string {
  // Prefer a path relative to the config file location if it already points to an existing project.
  const candidate = path.isAbsolute(projectPath)
    ? projectPath
    : path.resolve(projectPath);
  if (existsSync(candidate)) return candidate;

  // Fallback to resolving within the configured workspaceDir.
  return path.isAbsolute(projectPath)
    ? projectPath
    : path.resolve(workspaceDir, projectPath);
}

export async function runProjects(
  options: RunnerOptions,
): Promise<ProjectOutcome[]> {
  const outcomes: ProjectOutcome[] = [];
  for (const project of options.config.projects) {
    // sequential to simplify resource usage and logging order
    const outcome = await runSingleProject(project, options);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function runSingleProject(
  project: ProjectConfig,
  options: RunnerOptions,
): Promise<ProjectOutcome> {
  const { config, paths } = options;
  await ensureDir(paths.logsDir);

  const cwd = resolveProjectPath(config.workspaceDir, project.path);
  const logPath = path.join(paths.logsDir, `${sanitizeFileName(project.name)}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });

  if (!existsSync(cwd)) {
    const reason = `Project path not found: ${cwd}`;
    logStream.write(reason);
    logStream.end();
    return {
      name: project.name,
      passed: false,
      logPath,
      reason,
      durationMs: 0,
    };
  }

  const head = new HeadBuffer(40);
  const start = Date.now();
  let timedOut = false;
  let spawnError: Error | undefined;
  let exitCode: number | null = null;

  let child;
  try {
    child = spawn(project.tscCommand, {
      cwd,
      shell: true,
      env: { ...process.env },
    });
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err));
  }

  if (!child) {
    const reason = `Failed to start command "${project.tscCommand}": ${spawnError?.message ?? "unknown error"}`;
    logStream.write(reason);
    logStream.end();
    return {
      name: project.name,
      passed: false,
      logPath,
      reason,
      durationMs: 0,
    };
  }

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000);
  }, config.timeoutSec * 1000);

  child.stdout?.on("data", (data: Buffer) => {
    head.add(data);
    logStream.write(data);
  });

  child.stderr?.on("data", (data: Buffer) => {
    head.add(data);
    logStream.write(data);
  });

  child.on("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timer);
  logStream.end();
  const durationMs = Date.now() - start;

  if (spawnError) {
    return {
      name: project.name,
      passed: false,
      logPath,
      reason: `Failed to execute command: ${spawnError.message}`,
      durationMs,
    };
  }

  if (timedOut) {
    return {
      name: project.name,
      passed: false,
      logPath,
      reason: `Timed out after ${config.timeoutSec} seconds`,
      timedOut: true,
      durationMs,
    };
  }

  const passed = exitCode === 0;
  const reason = passed
    ? undefined
    : head.value() ||
      (exitCode === null
        ? "tsc exited without an exit code"
        : `tsc exited with code ${exitCode}`);

  return {
    name: project.name,
    passed,
    logPath,
    reason,
    exitCode: exitCode === null ? undefined : exitCode,
    durationMs,
  };
}

