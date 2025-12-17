#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { readConfig } from "./config.js";
import { runProjects } from "./runner.js";
import { buildSummary, Summary } from "./report.js";

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function main() {
  const program = new Command();
  program
    .name("typecheck-metrics")
    .description("Evaluate project-level TypeScript type-check success rate")
    .requiredOption("-c, --config <path>", "Path to config.json");

  // Some runners (pnpm + tsx) may inject a standalone "--" before user args.
  const argv = process.argv.filter((arg, idx) => !(idx >= 2 && arg === "--"));
  program.parse(argv);
  const opts = program.opts<{ config: string }>();

  const configPath = path.resolve(opts.config);
  const config = await readConfig(configPath);

  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", timestamp);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  console.log(`Running type-check across ${config.projects.length} project(s)`);

  const outcomes = await runProjects({
    config,
    paths: { runDir, logsDir },
  });

  const summary = buildSummary(outcomes, { runDir, logsDir });
  const summaryPath = path.join(runDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  printSummary(summary, summaryPath);
}

function printSummary(summary: Summary, summaryPath: string) {
  console.log("\n=== Type-check summary ===");
  console.log(`total: ${summary.metrics.projects_total}`);
  console.log(`passed: ${summary.metrics.projects_passed}`);
  console.log(`failed: ${summary.metrics.projects_failed}`);
  console.log(
    `pass_rate: ${(summary.metrics.pass_rate * 100).toFixed(2)}%`,
  );

  if (summary.failed_projects.length > 0) {
    console.log("\nFailed projects:");
    for (const project of summary.failed_projects) {
      console.log(`- ${project.name}`);
      console.log(`  reason: ${project.reason.split("\n").slice(0, 3).join(" | ")}`);
      console.log(`  log: ${project.log_path}`);
    }
  }

  console.log(`\nSummary saved to ${path.relative(process.cwd(), summaryPath)}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

