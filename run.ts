import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "glob";
import { genDts } from "./src/dts_generate_ours.js";

type Status = "success" | "config_error" | "type_error" | "other_error";

interface LegacyCliOptions {
  projectsPattern: string;
  headLines: number;
  timeoutSec: number;
}

interface ConditionOptions {
  condition: string;
  libName?: string;
  dtsPath?: string;
}

interface RunResult {
  project: string;
  status: Status;
  exitCode: number | null;
  errorCode?: string;
  stderr_head?: string;
  normalized: boolean;
  tsconfigPath?: string;
  durationMs: number;
  condition: string;
  libName?: string;
  injectedDtsPath?: string;
  injectionMode?: "tsconfig.injected" | "paths";
}

interface Manifest {
  workspaceDir: string;
  timeoutSec: number;
  projects: ManifestProject[];
}

type ManifestProject = {
  name: string;
  source:
    | { type: "local"; path: string }
    | { type: "git"; repo: string; ref: string; commit?: string };
  subdir?: string;
  packageManager: "pnpm" | "npm" | "yarn";
  installCommand: string;
  typecheckCommand: string;
};

interface LockEntry {
  name: string;
  repo?: string;
  resolvedCommit?: string;
  preparedAt: string;
}

interface LockFile {
  projects: LockEntry[];
}

interface PrepareResult {
  name: string;
  ok: boolean;
  resolvedCommit?: string;
  message?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "prepare") {
    const { manifestPath } = parseManifestArgs(args.slice(1));
    await runPrepare(manifestPath);
    return;
  }

  if (command === "eval") {
    const evalOpts = parseEvalArgs(args.slice(1));
    await runEval(evalOpts);
    return;
  }

  if (command === "gen-dts") {
    const genOpts = parseGenDtsArgs(args.slice(1));
    const result = await genDts({
      apiPath: genOpts.apiPath,
      outDir: genOpts.outDir,
    });
    console.log(`Generated: ${result.generatedDtsPath}`);
    console.log(`Queries: ${result.queriesPath}`);
    return;
  }

  // Legacy glob mode for backward compatibility
  if (args.includes("--projects")) {
    const opts = parseLegacyArgs(args);
    await legacyEval(opts);
    return;
  }

  console.error(
    "Usage:\n" +
      "  node run.js prepare --manifest <path>\n" +
      "  node run.js eval --manifest <path> [--head N] [--condition BL0|BL1|OURS] [--libName NAME] [--dts PATH]\n" +
      "  node run.js gen-dts --api <path> --out <dir>\n" +
      "  node run.js --projects <glob> [--head N] [--timeout S]  (legacy)",
  );
  process.exit(1);
}

function parseManifestArgs(args: string[]): { manifestPath: string } {
  let manifestPath = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") {
      manifestPath = args[i + 1] ?? "";
      i++;
    }
  }
  if (!manifestPath) {
    console.error("Usage: node run.js prepare --manifest <path>");
    process.exit(1);
  }
  return { manifestPath: path.resolve(manifestPath) };
}

function parseEvalArgs(args: string[]): {
  manifestPath: string;
  headLines: number;
  condition: string;
  libName?: string;
  dtsPath?: string;
} {
  let manifestPath = "";
  let headLines = 40;
  let condition = "BL0";
  let libName: string | undefined;
  let dtsPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--manifest") {
      manifestPath = args[++i] ?? "";
    } else if (arg === "--head") {
      headLines = Number(args[++i] ?? headLines);
    } else if (arg === "--condition") {
      condition = args[++i] ?? condition;
    } else if (arg === "--libName") {
      libName = args[++i];
    } else if (arg === "--dts") {
      dtsPath = args[++i];
    }
  }
  if (!manifestPath) {
    console.error("Usage: node run.js eval --manifest <path> [--head N] [--condition BL0|BL1|OURS] [--libName NAME] [--dts PATH]");
    process.exit(1);
  }
  return {
    manifestPath: path.resolve(manifestPath),
    headLines,
    condition,
    libName,
    dtsPath: dtsPath ? path.resolve(dtsPath) : undefined,
  };
}

function parseGenDtsArgs(args: string[]): { apiPath: string; outDir: string } {
  let apiPath = "";
  let outDir = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api") {
      apiPath = args[++i] ?? "";
    } else if (arg === "--out") {
      outDir = args[++i] ?? "";
    }
  }
  if (!apiPath || !outDir) {
    console.error("Usage: node run.js gen-dts --api <path> --out <dir>");
    process.exit(1);
  }
  return { apiPath: path.resolve(apiPath), outDir: path.resolve(outDir) };
}

function parseLegacyArgs(args: string[]): LegacyCliOptions {
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

async function runPrepare(manifestPath: string) {
  const manifest = await readManifest(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const lockPath = path.join(manifestDir, "lock.json");
  const existingLock = await readLock(lockPath);

  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", timestamp);
  const logsDir = path.join(runDir, "prepare-logs");
  await fs.mkdir(logsDir, { recursive: true });

  const lockEntries: LockEntry[] = [];
  const results: PrepareResult[] = [];

  for (const project of manifest.projects) {
    const targetDir = resolveProjectRoot(manifestDir, manifest.workspaceDir, project);
    const workDir = project.subdir ? path.join(targetDir, project.subdir) : targetDir;
    const logPath = path.join(logsDir, `${sanitizeFileName(project.name)}.log`);
    await fs.writeFile(logPath, "");

    if (project.source.type === "git") {
      const lockCommit = findLockCommit(existingLock, project.name);
      const desiredRef = lockCommit ?? project.source.commit ?? project.source.ref;
      const prep = await prepareGitProject({
        project,
        targetDir,
        desiredRef,
        logPath,
      });
      if (prep.ok) {
        const resolvedCommit = prep.resolvedCommit ?? desiredRef;
        lockEntries.push({
          name: project.name,
          repo: project.source.repo,
          resolvedCommit,
          preparedAt: new Date().toISOString(),
        });
      } else if (lockCommit) {
        // keep old lock entry if preparation failed but lock existed
        const old = existingLock?.projects.find((p) => p.name === project.name);
        if (old) lockEntries.push(old);
      }
      results.push(prep);
    } else {
      // local project: just record that it exists
      const ok = existsSync(workDir);
      results.push({
        name: project.name,
        ok,
        message: ok ? "local project ready" : `path not found: ${workDir}`,
      });
      lockEntries.push({
        name: project.name,
        preparedAt: new Date().toISOString(),
      });
    }

    // install step for both git/local when the project dir exists
    if (existsSync(workDir)) {
      const installRes = await runCommand(project.installCommand, workDir, manifest.timeoutSec, logPath);
      if (installRes.exitCode !== 0) {
        results.push({
          name: project.name,
          ok: false,
          message: `install failed with code ${installRes.exitCode}`,
        });
      }
    }
  }

  await writeLock(lockPath, lockEntries);

  console.log("\nPrepare results:");
  for (const r of results) {
    console.log(`- ${r.name}: ${r.ok ? "ok" : "fail"}${r.message ? ` (${r.message})` : ""}`);
  }
  console.log(`\nLock written to ${path.relative(process.cwd(), lockPath)}`);
  console.log(`Prepare logs in ${path.relative(process.cwd(), logsDir)}`);
}

async function runEval(evalOpts: {
  manifestPath: string;
  headLines: number;
  condition: string;
  libName?: string;
  dtsPath?: string;
}) {
  const manifest = await readManifest(evalOpts.manifestPath);
  const manifestDir = path.dirname(evalOpts.manifestPath);
  const lockPath = path.join(manifestDir, "lock.json");
  const lock = await readLock(lockPath);

  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", `${timestamp}-eval`);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const results: RunResult[] = [];
  const conditionInfo: ConditionOptions = {
    condition: evalOpts.condition,
    libName: evalOpts.libName,
    dtsPath: evalOpts.dtsPath,
  };

  // Auto-generate baseline DTS if BL1 and no explicit path.
  let injectedDtsPath = evalOpts.dtsPath;
  if (conditionInfo.condition === "BL1") {
    if (!conditionInfo.libName) {
      console.error("BL1 requires --libName");
      process.exit(1);
    }
    if (!injectedDtsPath) {
      injectedDtsPath = await generateBaselineDts(conditionInfo.libName);
    }
    conditionInfo.dtsPath = injectedDtsPath;
  }

  for (const project of manifest.projects) {
    const targetDir = resolveProjectRoot(manifestDir, manifest.workspaceDir, project);
    const workDir = project.subdir ? path.join(targetDir, project.subdir) : targetDir;
    const logPath = path.join(logsDir, `${sanitizeFileName(project.name)}.log`);

    if (project.source.type === "git") {
      const lockCommit = findLockCommit(lock, project.name);
      const desiredRef = lockCommit ?? project.source.commit ?? project.source.ref;
      await ensureGitCheckout({
        project,
        targetDir,
        desiredRef,
        logPath,
      });
    }

    const result = await runProjectWithManifest(
      project,
      workDir,
      manifest.timeoutSec,
      evalOpts.headLines,
      logPath,
      {
        condition: conditionInfo.condition,
        libName: conditionInfo.libName,
        dtsPath: conditionInfo.dtsPath,
      },
    );
    results.push(result);
    console.log(
      `[${result.status}] ${project.name} ` +
        (result.errorCode ? `(code: ${result.errorCode})` : ""),
    );
  }

  const resultsPath = path.join(runDir, "results.jsonl");
  const lines = results.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(resultsPath, lines + "\n", "utf8");
  console.log(`\nSaved results to ${path.relative(process.cwd(), resultsPath)}`);
  const summaryPath = path.join(runDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(buildSummary(results, conditionInfo), null, 2));
  console.log(`Summary saved to ${path.relative(process.cwd(), summaryPath)}`);
}

async function legacyEval(opts: LegacyCliOptions) {
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

  const results: RunResult[] = [];
  for (const projectPath of projectPaths) {
    const result = await runProjectLegacy(projectPath, opts, logsDir);
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

async function readManifest(manifestPath: string): Promise<Manifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const data = JSON.parse(raw);
  if (!data.workspaceDir || !data.projects) {
    throw new Error("manifest missing workspaceDir or projects");
  }
  return data as Manifest;
}

async function readLock(lockPath: string): Promise<LockFile | null> {
  if (!existsSync(lockPath)) return null;
  const raw = await fs.readFile(lockPath, "utf8");
  return JSON.parse(raw) as LockFile;
}

async function writeLock(lockPath: string, projects: LockEntry[]): Promise<void> {
  const lock: LockFile = { projects };
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
}

function findLockCommit(lock: LockFile | null, name: string): string | undefined {
  return lock?.projects.find((p) => p.name === name)?.resolvedCommit;
}

function resolveProjectRoot(
  manifestDir: string,
  workspaceDir: string,
  project: ManifestProject,
): string {
  if (project.source.type === "local") {
    return path.resolve(manifestDir, project.source.path);
  }
  const base = path.resolve(manifestDir, workspaceDir);
  return path.join(base, project.name);
}

async function prepareGitProject(args: {
  project: ManifestProject & { source: { type: "git"; repo: string; ref: string; commit?: string } };
  targetDir: string;
  desiredRef: string;
  logPath: string;
}): Promise<PrepareResult> {
  const { project, targetDir, desiredRef, logPath } = args;

  const cloneOrFetch = existsSync(targetDir)
    ? ["git", ["-C", targetDir, "fetch", "--all", "--tags", "--prune"]]
    : ["git", ["clone", project.source.repo, targetDir]];

  const fetchRes = await runCommandArray(cloneOrFetch[0], cloneOrFetch[1] as string[], process.cwd(), 300, logPath);
  if (fetchRes.exitCode !== 0) {
    return { name: project.name, ok: false, message: "git fetch/clone failed" };
  }

  const checkoutRes = await runCommandArray("git", ["-C", targetDir, "checkout", desiredRef], process.cwd(), 300, logPath);
  if (checkoutRes.exitCode !== 0) {
    return { name: project.name, ok: false, message: `git checkout ${desiredRef} failed` };
  }

  const rev = await runCommandArray("git", ["-C", targetDir, "rev-parse", "HEAD"], process.cwd(), 60, logPath);
  const resolvedCommit = rev.stdout.trim();
  return { name: project.name, ok: true, resolvedCommit };
}

async function ensureGitCheckout(args: {
  project: ManifestProject & { source: { type: "git"; repo: string; ref: string; commit?: string } };
  targetDir: string;
  desiredRef: string;
  logPath: string;
}) {
  const { project, targetDir, desiredRef, logPath } = args;
  if (!existsSync(targetDir)) {
    const cloneRes = await runCommandArray(
      "git",
      ["clone", project.source.repo, targetDir],
      process.cwd(),
      300,
      logPath,
    );
    if (cloneRes.exitCode !== 0) return;
  } else {
    await runCommandArray("git", ["-C", targetDir, "fetch", "--all", "--tags", "--prune"], process.cwd(), 300, logPath);
  }
  await runCommandArray("git", ["-C", targetDir, "checkout", desiredRef], process.cwd(), 300, logPath);
}

async function runProjectWithManifest(
  project: ManifestProject,
  workDir: string,
  timeoutSec: number,
  headLines: number,
  logPath: string,
  conditionOpts: ConditionOptions,
): Promise<RunResult> {
  const tsconfigPath = path.join(workDir, "tsconfig.json");
  let normalized = false;
  let restoreFn: (() => Promise<void>) | undefined;
  let injectedTsconfig: string | undefined;
  let injectionMode: "tsconfig.injected" | "paths" | undefined;

  if (!existsSync(workDir)) {
    return {
      project: workDir,
      status: "config_error",
      exitCode: null,
      errorCode: "PROJECT_MISSING",
      stderr_head: `Project path not found: ${workDir}`,
      normalized,
      tsconfigPath,
      durationMs: 0,
      condition: conditionOpts.condition,
      libName: conditionOpts.libName,
      injectedDtsPath: conditionOpts.dtsPath,
    };
  }

  if (!existsSync(tsconfigPath)) {
    return {
      project: workDir,
      status: "config_error",
      exitCode: null,
      errorCode: "TSCONFIG_MISSING",
      stderr_head: `tsconfig.json not found in ${workDir}`,
      normalized,
      tsconfigPath,
      durationMs: 0,
      condition: conditionOpts.condition,
      libName: conditionOpts.libName,
      injectedDtsPath: conditionOpts.dtsPath,
    };
  }

  try {
    const normalization = await normalizeTsconfig(tsconfigPath);
    normalized = normalization.normalized;
    restoreFn = normalization.restore;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      project: workDir,
      status: "config_error",
      exitCode: null,
      errorCode: "TSCONFIG_PARSE",
      stderr_head: msg,
      normalized,
      tsconfigPath,
      durationMs: 0,
      condition: conditionOpts.condition,
      libName: conditionOpts.libName,
      injectedDtsPath: conditionOpts.dtsPath,
    };
  }

  const started = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runCommand(
    conditionOpts.condition === "BL0"
      ? project.typecheckCommand
      : await buildInjectedCommand(workDir, conditionOpts, tsconfigPath, (tsconfig) => {
          injectedTsconfig = tsconfig;
          injectionMode = "tsconfig.injected";
        }),
    workDir,
    timeoutSec,
    logPath,
  );
  const durationMs = Date.now() - started;
  const errorCode = firstErrorCode(stderr || stdout);
  const status = classify(exitCode, errorCode, timedOut);
  const stderrHead =
    status === "success"
      ? undefined
      : head(stderr || stdout, headLines);

  if (restoreFn) {
    await restoreFn();
  }
  if (injectedTsconfig) {
    await fs.rm(injectedTsconfig, { force: true });
  }

  return {
    project: workDir,
    status,
    exitCode,
    errorCode: status === "success" ? undefined : errorCode,
    stderr_head: stderrHead,
    normalized,
    tsconfigPath,
    durationMs,
    condition: conditionOpts.condition,
    libName: conditionOpts.libName,
    injectedDtsPath: conditionOpts.dtsPath,
    injectionMode,
  };
}

async function buildInjectedCommand(
  workDir: string,
  conditionOpts: ConditionOptions,
  tsconfigPath: string,
  setInjected: (tsconfigPath: string) => void,
): Promise<string> {
  if (!conditionOpts.libName || !conditionOpts.dtsPath) {
    throw new Error("BL1 requires --libName and --dts (or auto-generated)");
  }
  const injectedPath = path.join(workDir, "tsconfig.injected.json");
  const paths: Record<string, string[]> = {};
  paths[conditionOpts.libName] = [conditionOpts.dtsPath];
  const dir = path.dirname(conditionOpts.dtsPath);
  paths[`${conditionOpts.libName}/*`] = [path.join(dir, "*")];

  const injected = {
    extends: "./tsconfig.json",
    compilerOptions: {
      baseUrl: ".",
      paths,
    },
  };
  await fs.writeFile(injectedPath, JSON.stringify(injected, null, 2));
  setInjected(injectedPath);
  // use absolute path to avoid cwd issues
  return `npx tsc --noEmit -p "${injectedPath}"`;
}

async function runProjectLegacy(
  projectPath: string,
  opts: LegacyCliOptions,
  logsDir: string,
): Promise<RunResult> {
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  const logPath = path.join(logsDir, `${sanitizeFileName(projectPath)}.log`);

  let normalized = false;
  let restoreFn: (() => Promise<void>) | undefined;

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
    condition: "legacy",
  };
}

async function generateBaselineDts(libName: string): Promise<string> {
  const outDir = path.resolve(process.cwd(), "generated-dts", "BL1", libName);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.d.ts");
  const content = `declare module "${libName}" {\n  const _default: any;\n  export = _default;\n}\nexport {};\n`;
  await fs.writeFile(outPath, content, "utf8");
  return outPath;
}

function buildSummary(
  results: RunResult[],
  conditionInfo: ConditionOptions,
): {
  condition: string;
  libName?: string;
  injectedDtsPath?: string;
  injectionMode?: string;
  metrics: Record<string, number>;
} {
  const metrics: Record<string, number> = {
    total: results.length,
    success: 0,
    config_error: 0,
    type_error: 0,
    other_error: 0,
  };
  for (const r of results) {
    metrics[r.status] = (metrics[r.status] ?? 0) + 1;
  }
  return {
    condition: conditionInfo.condition,
    libName: conditionInfo.libName,
    injectedDtsPath: conditionInfo.dtsPath,
    injectionMode: results.find((r) => r.injectionMode)?.injectionMode,
    metrics,
  };
}

async function normalizeTsconfig(tsconfigPath: string): Promise<{
  normalized: boolean;
  restore: () => Promise<void>;
}> {
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

function runTsc(
  cwd: string,
  timeoutSec: number,
  logPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return runCommand("npx tsc --noEmit", cwd, timeoutSec, logPath);
}

function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  logPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
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
      void fs.appendFile(logPath, stdout + stderr, "utf8");
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const combined = `${stderr}${stderr ? "\n" : ""}${msg}`;
      void fs.appendFile(logPath, combined, "utf8");
      resolve({ exitCode: 1, stdout, stderr: combined, timedOut });
    });
  });
}

function runCommandArray(
  command: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
  logPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
      void fs.appendFile(logPath, stdout + stderr, "utf8");
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const combined = `${stderr}${stderr ? "\n" : ""}${msg}`;
      void fs.appendFile(logPath, combined, "utf8");
      resolve({ exitCode: 1, stdout, stderr: combined, timedOut });
    });
  });
}

function firstErrorCode(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = output.match(/TS\d{4}/);
  return match?.[0];
}

function classify(
  exitCode: number | null,
  errorCode: string | undefined,
  timedOut: boolean,
): Status {
  if (timedOut) return "other_error";
  if (exitCode === 0) return "success";
  if (errorCode && /^TS(50|180)/.test(errorCode)) return "config_error";
  if (errorCode) return "type_error";
  return "other_error";
}

function head(text: string, maxLines: number): string {
  return text.split(/\r?\n/).slice(0, maxLines).join("\n");
}

function sanitizeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

