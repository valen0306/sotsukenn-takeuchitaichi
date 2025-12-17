import path from "node:path";
import { ProjectOutcome, RunPaths } from "./runner.js";

export interface FailedProject {
  name: string;
  reason: string;
  log_path: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface Summary {
  runAt: string;
  runDir: string;
  metrics: {
    projects_total: number;
    projects_passed: number;
    projects_failed: number;
    pass_rate: number;
  };
  failed_projects: FailedProject[];
  projects: ProjectOutcome[];
}

export function buildSummary(
  outcomes: ProjectOutcome[],
  paths: RunPaths,
): Summary {
  const total = outcomes.length;
  const passed = outcomes.filter((p) => p.passed).length;
  const failed = total - passed;
  const failedProjects: FailedProject[] = outcomes
    .filter((p) => !p.passed)
    .map((p) => ({
      name: p.name,
      reason: p.reason ?? "Failed without error output",
      log_path: path.relative(process.cwd(), p.logPath),
      exitCode: p.exitCode,
      timedOut: p.timedOut,
    }));

  return {
    runAt: new Date().toISOString(),
    runDir: path.relative(process.cwd(), paths.runDir),
    metrics: {
      projects_total: total,
      projects_passed: passed,
      projects_failed: failed,
      pass_rate: total === 0 ? 0 : passed / total,
    },
    failed_projects: failedProjects,
    projects: outcomes,
  };
}

