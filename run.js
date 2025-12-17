import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "glob";

async function main() {
  const opts = parseArgs();
  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", `${timestamp}-harness`);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const projectPaths = await glob(opts.projectsPattern, { absolute: true });
  if (projectPaths.length === 0) {
    console.error(`No projects matched pattern: ${opts.projectsPattern}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const projectPath of projectPaths) {
    const result = await runProject(projectPath, opts, logsDir);
    results.push(result);
    console.log(
      `[${result.status}] ${projectPath} ` +
        (result.errorCode ? `(code: ${result.errorCode})` : ""),
    );
  }

  const resultsPath = path.join(runDir, "results.jsonl");
  const lines = results.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(resultsPath, lines + "\n", "utf8");
  console.log(`\nSaved results to ${path.relative(process.cwd(), resultsPath)}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let projectsPattern = "";
  let headLines = 40;
  let timeoutSec = 120;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--projects") {
      projectsPattern = args[++i] ?? "";
    } else if (arg === "--head") {
      headLines = Number(args[++i] ?? headLines);
    } else if (arg === "--timeout") {
      timeoutSec = Number(args[++i] ?? timeoutSec);
    }
  }

  if (!projectsPattern) {
    console.error("Usage: node run.js --projects <glob> [--head N] [--timeout S]");
    process.exit(1);
  }

  return { projectsPattern, headLines, timeoutSec };
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function runProject(projectPath, opts, logsDir) {
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  const logPath = path.join(logsDir, `${sanitizeFileName(projectPath)}.log`);

  let normalized = false;
  let restoreFn;

  if (!existsSync(projectPath)) {
    return {
      project: projectPath,
      status: "config_error",
      exitCode: null,
      errorCode: "TSCONFIG_MISSING",
      stderr_head: `Project path not found: ${projectPath}`,
      normalized,
      tsconfigPath,
      durationMs: 0,
    };
  }

  if (!existsSync(tsconfigPath)) {
    return {
      project: projectPath,
      status: "config_error",
      exitCode: null,
      errorCode: "TSCONFIG_MISSING",
      stderr_head: `tsconfig.json not found in ${projectPath}`,
      normalized,
      tsconfigPath,
      durationMs: 0,
    };
  }

  try {
    const normalization = await normalizeTsconfig(tsconfigPath);
    normalized = normalization.normalized;
    restoreFn = normalization.restore;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      project: projectPath,
      status: "config_error",
      exitCode: null,
      errorCode: "TSCONFIG_PARSE",
      stderr_head: msg,
      normalized,
      tsconfigPath,
      durationMs: 0,
    };
  }

  const started = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runTsc(
    projectPath,
    opts.timeoutSec,
    logPath,
  );
  const durationMs = Date.now() - started;
  const errorCode = firstErrorCode(stderr || stdout);
  const status = classify(exitCode, errorCode, timedOut);
  const stderrHead =
    status === "success"
      ? undefined
      : head((stderr || stdout), opts.headLines);

  if (restoreFn) {
    await restoreFn();
  }

  return {
    project: projectPath,
    status,
    exitCode,
    errorCode: status === "success" ? undefined : errorCode,
    stderr_head: stderrHead,
    normalized,
    tsconfigPath,
    durationMs,
  };
}

async function normalizeTsconfig(tsconfigPath) {
  const raw = await fs.readFile(tsconfigPath, "utf8");
  const data = JSON.parse(raw);
  const compilerOptions = (data.compilerOptions ??= {});
  const backupPath = `${tsconfigPath}.bak`;
  await fs.copyFile(tsconfigPath, backupPath);

  let normalized = false;
  if (
    compilerOptions.moduleResolution === "NodeNext" &&
    compilerOptions.module !== "NodeNext"
  ) {
    compilerOptions.module = "NodeNext";
    normalized = true;
  }

  if (normalized) {
    await fs.writeFile(tsconfigPath, JSON.stringify(data, null, 2));
  }

  return {
    normalized,
    restore: async () => {
      await fs.copyFile(backupPath, tsconfigPath);
      await fs.rm(backupPath, { force: true });
    },
  };
}

function runTsc(cwd, timeoutSec, logPath) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsc", "--noEmit"], {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutSec * 1000);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      void fs.writeFile(logPath, stdout + stderr, "utf8");
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const combined = `${stderr}${stderr ? "\n" : ""}${msg}`;
      void fs.writeFile(logPath, combined, "utf8");
      resolve({ exitCode: 1, stdout, stderr: combined, timedOut });
    });
  });
}

function firstErrorCode(output) {
  if (!output) return undefined;
  const match = output.match(/TS\d{4}/);
  return match?.[0];
}

function classify(exitCode, errorCode, timedOut) {
  if (timedOut) return "other_error";
  if (exitCode === 0) return "success";
  if (errorCode && /^TS(50|180)/.test(errorCode)) return "config_error";
  if (errorCode) return "type_error";
  return "other_error";
}

function head(text, maxLines) {
  return text.split(/\r?\n/).slice(0, maxLines).join("\n");
}

function sanitizeFileName(input) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

