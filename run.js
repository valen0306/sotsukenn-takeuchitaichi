import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "glob";
import { genDts } from "./src/dts_generate_ours.js";

function getTscCliCommand() {
  // Prefer repository-local TypeScript to avoid npx downloading (important for offline/sandboxed runs).
  const localTsc = path.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  if (existsSync(localTsc)) {
    return `node "${localTsc}"`;
  }
  return "npx tsc";
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

  if (command === "experiment") {
    const expOpts = parseExperimentArgs(args.slice(1));
    await runExperiment(expOpts);
    return;
  }

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
      "  node run.js experiment --scenarios <glob> --matrix <path> --out <dir> [--resume]\n" +
      "  node run.js --projects <glob> [--head N] [--timeout S]  (legacy)",
  );
  process.exit(1);
}

function parseManifestArgs(args) {
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

function parseEvalArgs(args) {
  let manifestPath = "";
  let scenariosPattern = "";
  let headLines = 40;
  let condition = "BL0";
  let libName;
  let dtsPath;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--manifest") {
      manifestPath = args[++i] ?? "";
    } else if (arg === "--scenarios") {
      scenariosPattern = args[++i] ?? "";
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
  if (!manifestPath && !scenariosPattern) {
    console.error("Usage: node run.js eval (--manifest <path> | --scenarios <glob>) [--head N] [--condition BL0|BL1|OURS] [--libName NAME] [--dts PATH]");
    process.exit(1);
  }
  return {
    manifestPath: manifestPath ? path.resolve(manifestPath) : undefined,
    scenariosPattern,
    headLines,
    condition,
    libName,
    dtsPath: dtsPath ? path.resolve(dtsPath) : undefined,
  };
}

function parseGenDtsArgs(args) {
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

function parseExperimentArgs(args) {
  let scenariosPattern = "";
  let matrixPath = "";
  let outDir = "";
  let resume = false;
  let headLines = 40;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scenarios") {
      scenariosPattern = args[++i] ?? "";
    } else if (arg === "--matrix") {
      matrixPath = args[++i] ?? "";
    } else if (arg === "--out") {
      outDir = args[++i] ?? "";
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--head") {
      headLines = Number(args[++i] ?? headLines);
    }
  }
  if (!scenariosPattern || !matrixPath || !outDir) {
    console.error("Usage: node run.js experiment --scenarios <glob> --matrix <path> --out <dir> [--resume]");
    process.exit(1);
  }
  return {
    scenariosPattern,
    matrixPath: path.resolve(matrixPath),
    outDir: path.resolve(outDir),
    resume,
    headLines,
  };
}

function parseLegacyArgs(args) {
  let projectsPattern = "";
  let headLines = 40;
  let timeoutSec = 120;
  let repair = false;
  let topk = 5;
  let maxIters = 30;
  let beam = 1;
  let trivialPenalty = 5;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--projects") {
      projectsPattern = args[++i] ?? "";
    } else if (arg === "--head") {
      headLines = Number(args[++i] ?? headLines);
    } else if (arg === "--timeout") {
      timeoutSec = Number(args[++i] ?? timeoutSec);
    } else if (arg === "--repair") {
      repair = true;
    } else if (arg === "--topk") {
      topk = Number(args[++i] ?? topk);
    } else if (arg === "--maxIters") {
      maxIters = Number(args[++i] ?? maxIters);
    } else if (arg === "--beam") {
      beam = Number(args[++i] ?? beam);
    } else if (arg === "--trivialPenalty") {
      trivialPenalty = Number(args[++i] ?? trivialPenalty);
    }
  }

  if (!projectsPattern) {
    console.error("Usage: node run.js --projects <glob> [--head N] [--timeout S]");
    process.exit(1);
  }

  return { projectsPattern, headLines, timeoutSec, repair, topk, maxIters, beam, trivialPenalty };
}

async function runPrepare(manifestPath) {
  const manifest = await readManifest(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const lockPath = path.join(manifestDir, "lock.json");
  const existingLock = await readLock(lockPath);

  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", timestamp);
  const logsDir = path.join(runDir, "prepare-logs");
  await fs.mkdir(logsDir, { recursive: true });

  const lockEntries = [];
  const results = [];

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
        const old = existingLock?.projects.find((p) => p.name === project.name);
        if (old) lockEntries.push(old);
      }
      results.push(prep);
    } else {
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

async function runEval(evalOpts) {
  if (evalOpts.scenariosPattern) {
    await runScenarioEval(evalOpts);
    return;
  }

  const manifest = await readManifest(evalOpts.manifestPath);
  const manifestDir = path.dirname(evalOpts.manifestPath);
  const lockPath = path.join(manifestDir, "lock.json");
  const lock = await readLock(lockPath);

  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", `${timestamp}-eval`);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const results = [];
  const conditionInfo = {
    condition: evalOpts.condition,
    libName: evalOpts.libName,
    dtsPath: evalOpts.dtsPath,
  };

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

async function runScenarioEval(evalOpts) {
  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", `${timestamp}-scenarios`);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const scenarioPaths = await glob(evalOpts.scenariosPattern, { absolute: true });
  if (scenarioPaths.length === 0) {
    console.error(`No scenarios matched pattern: ${evalOpts.scenariosPattern}`);
    process.exitCode = 1;
    return;
  }

  const scenarios = [];
  for (const p of scenarioPaths) {
    const raw = await fs.readFile(p, "utf8");
    const obj = JSON.parse(raw);
    const base = path.dirname(p);
    const resolvePath = (inputPath) => {
      if (!inputPath) return inputPath;
      if (path.isAbsolute(inputPath)) return inputPath;
      // Prefer scenario-file-relative, but fall back to repo-root-relative for convenience.
      const a = path.resolve(base, inputPath);
      if (existsSync(a)) return a;
      const b = path.resolve(process.cwd(), inputPath);
      return b;
    };
    scenarios.push({
      id: obj.id,
      consumerPath: resolvePath(obj.consumerPath),
      libraryName: obj.libraryName,
      predictedDtsPath: resolvePath(obj.predictedDtsPath),
      _scenarioFile: p,
    });
  }

  const nodeVersion = process.version;
  const tscVersion = await getTscVersion();

  const results = [];
  for (const sc of scenarios) {
    // baseline
    const baseline = await evalScenarioOnce({
      sc,
      mode: "baseline",
      inject: false,
      logsDir,
      headLines: evalOpts.headLines,
      nodeVersion,
      tscVersion,
    });
    results.push(baseline);
    console.log(`[${baseline.status}] ${sc.id} baseline`);

    // predicted
    const predicted = await evalScenarioOnce({
      sc,
      mode: "predicted",
      inject: true,
      logsDir,
      headLines: evalOpts.headLines,
      nodeVersion,
      tscVersion,
    });
    results.push(predicted);
    console.log(`[${predicted.status}] ${sc.id} predicted`);
  }

  const resultsPath = path.join(runDir, "results.eval.jsonl");
  await fs.writeFile(resultsPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const summary = buildScenarioSummary(results);
  const summaryPath = path.join(runDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`\nSaved results to ${path.relative(process.cwd(), resultsPath)}`);
  console.log(`Saved summary to ${path.relative(process.cwd(), summaryPath)}`);
}

async function evalScenarioOnce(args) {
  const { sc, mode, inject, logsDir, headLines, nodeVersion, tscVersion } = args;
  const logPath = path.join(logsDir, `${sanitizeFileName(sc.id)}.${mode}.log`);
  await fs.writeFile(logPath, "");

  const started = Date.now();
  let restoreInjection = async () => {};
  let normalization;
  try {
    if (inject) {
      const inj = await injectDtsIntoNodeModules(sc.consumerPath, sc.libraryName, sc.predictedDtsPath);
      restoreInjection = inj.restore;
    }
    const tsconfigPath = path.join(sc.consumerPath, "tsconfig.json");
    normalization = await normalizeTsconfig(tsconfigPath);
    const { exitCode, stdout, stderr, timedOut } = await runCommand(
      `${getTscCliCommand()} --noEmit`,
      sc.consumerPath,
      120,
      logPath,
    );
    const durationMs = Date.now() - started;
    const combined = (stderr || "") + (stdout || "");
    const errorCode = firstErrorCode(combined);
    const status = classify(exitCode, errorCode, timedOut);
    const stderrHead = status === "success" ? undefined : head(combined, headLines);
    return {
      scenarioId: sc.id,
      mode,
      status,
      errorCode: status === "success" ? undefined : errorCode,
      stderr_head: stderrHead,
      durationMs,
      nodeVersion,
      tscVersion,
      logPath: path.relative(process.cwd(), logPath),
    };
  } finally {
    if (normalization) await normalization.restore();
    await restoreInjection();
  }
}

async function injectDtsIntoNodeModules(consumerPath, libraryName, predictedDtsPath) {
  const typesDir = path.join(consumerPath, "node_modules", "@types", libraryName);
  const target = path.join(typesDir, "index.d.ts");
  const backup = `${target}.bak_phase5`;
  await fs.mkdir(typesDir, { recursive: true });

  const hadOriginal = existsSync(target);
  if (hadOriginal) {
    await fs.copyFile(target, backup);
  }
  await fs.copyFile(predictedDtsPath, target);

  return {
    restore: async () => {
      if (hadOriginal) {
        await fs.copyFile(backup, target);
        await fs.rm(backup, { force: true });
      } else {
        await fs.rm(target, { force: true });
        // cleanup empty dirs if possible
        await tryRemoveIfEmpty(typesDir);
        await tryRemoveIfEmpty(path.join(consumerPath, "node_modules", "@types"));
      }
    },
  };
}

async function tryRemoveIfEmpty(dir) {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) {
      await fs.rmdir(dir);
    }
  } catch {
    // ignore
  }
}

async function getTscVersion() {
  return new Promise((resolve) => {
    const child = spawn(`${getTscCliCommand()} -v`, {
      cwd: process.cwd(),
      shell: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const m = out.match(/Version\s+([0-9.]+)/);
      resolve(m ? m[1] : "unknown");
    });
    child.on("error", () => resolve("unknown"));
  });
}

function buildScenarioSummary(results) {
  const baseline = results.filter((r) => r.mode === "baseline");
  const predicted = results.filter((r) => r.mode === "predicted");
  const baselinePassed = baseline.filter((r) => r.status === "success").length;
  const predictedPassed = predicted.filter((r) => r.status === "success").length;
  const baselineRate = baseline.length ? baselinePassed / baseline.length : 0;
  const predictedRate = predicted.length ? predictedPassed / predicted.length : 0;

  const baselineCodes = countErrorCodes(baseline);
  const predictedCodes = countErrorCodes(predicted);
  const deltas = [];
  const allCodes = new Set([...Object.keys(baselineCodes), ...Object.keys(predictedCodes)]);
  for (const code of allCodes) {
    const b = baselineCodes[code] ?? 0;
    const p = predictedCodes[code] ?? 0;
    deltas.push({ code, baseline: b, predicted: p, delta: p - b });
  }
  const increased = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10);
  const decreased = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10);

  return {
    metrics: {
      baseline_success_rate: baselineRate,
      predicted_success_rate: predictedRate,
      delta: predictedRate - baselineRate,
      baseline_total: baseline.length,
      predicted_total: predicted.length,
    },
    error_code_delta_top: {
      increased,
      decreased,
    },
  };
}

function countErrorCodes(rows) {
  const counts = {};
  for (const r of rows) {
    if (!r.errorCode) continue;
    counts[r.errorCode] = (counts[r.errorCode] ?? 0) + 1;
  }
  return counts;
}

async function runExperiment(expOpts) {
  const matrixRaw = await fs.readFile(expOpts.matrixPath, "utf8");
  const matrix = JSON.parse(matrixRaw);
  const conditions = matrix.conditions ?? [];
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error("matrix.json must contain non-empty conditions[]");
  }

  await fs.mkdir(expOpts.outDir, { recursive: true });

  for (const cond of conditions) {
    const conditionId = cond.id;
    const conditionDir = path.join(expOpts.outDir, conditionId);
    const summaryPath = path.join(conditionDir, "summary.json");
    if (expOpts.resume && existsSync(summaryPath)) {
      console.log(`Skipping ${conditionId} (resume, summary exists)`);
      continue;
    }
    await fs.mkdir(conditionDir, { recursive: true });
    await runScenarioEvalForCondition({
      scenariosPattern: expOpts.scenariosPattern,
      condition: cond,
      outDir: conditionDir,
      headLines: expOpts.headLines,
    });
  }

  const aggregate = await buildAggregate(expOpts.outDir, conditions.map((c) => c.id));
  const aggregatePath = path.join(expOpts.outDir, "aggregate.json");
  await fs.writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), "utf8");
  console.log(`\nSaved aggregate to ${path.relative(process.cwd(), aggregatePath)}`);
}

async function runScenarioEvalForCondition(args) {
  const { scenariosPattern, condition, outDir, headLines } = args;
  const logsDir = path.join(outDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const scenarioPaths = await glob(scenariosPattern, { absolute: true });
  if (scenarioPaths.length === 0) {
    throw new Error(`No scenarios matched pattern: ${scenariosPattern}`);
  }

  const scenarios = [];
  for (const p of scenarioPaths) {
    const raw = await fs.readFile(p, "utf8");
    const obj = JSON.parse(raw);
    const base = path.dirname(p);
    const resolvePath = (inputPath) => {
      if (!inputPath) return inputPath;
      if (path.isAbsolute(inputPath)) return inputPath;
      const a = path.resolve(base, inputPath);
      if (existsSync(a)) return a;
      return path.resolve(process.cwd(), inputPath);
    };
    scenarios.push({
      id: obj.id,
      consumerPath: resolvePath(obj.consumerPath),
      libraryName: obj.libraryName,
      predictedDtsPath: resolvePath(obj.predictedDtsPath),
      _scenarioFile: p,
    });
  }

  const nodeVersion = process.version;
  const tscVersion = await getTscVersion();

  const results = [];
  for (const sc of scenarios) {
    const baseline = await evalScenarioOnce({
      sc,
      mode: "baseline",
      inject: false,
      logsDir,
      headLines,
      nodeVersion,
      tscVersion,
    });
    results.push({ ...baseline, conditionId: condition.id });

    const predictedDtsPath = await getPredictedDtsForCondition(condition, sc, outDir);
    const predicted = await evalScenarioOnce({
      sc: { ...sc, predictedDtsPath },
      mode: "predicted",
      inject: condition.mode !== "BL0",
      logsDir,
      headLines,
      nodeVersion,
      tscVersion,
    });
    results.push({ ...predicted, conditionId: condition.id, predictedDtsPath });
  }

  const resultsPath = path.join(outDir, "results.eval.jsonl");
  await fs.writeFile(resultsPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const summary = buildScenarioSummary(results);
  summary.condition = condition;
  const summaryPath = path.join(outDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
}

async function getPredictedDtsForCondition(condition, sc, conditionOutDir) {
  const mode = condition.mode;
  if (mode === "BL0") {
    return sc.predictedDtsPath; // unused
  }
  if (mode === "BL1") {
    return await generateAnyStubDts(
      sc.libraryName,
      path.join(conditionOutDir, "generated-dts", "BL1"),
      sc.consumerPath,
    );
  }
  if (mode === "OURS_TOP1" || mode === "OURS_USAGE_TOP1") {
    // Minimal: reuse any-stub as placeholder for "OURS" output
    return await generateAnyStubDts(
      sc.libraryName,
      path.join(conditionOutDir, "generated-dts", "OURS_TOP1"),
      mode.includes("USAGE") ? sc.consumerPath : undefined,
    );
  }
  if (mode === "OURS_REPAIR" || mode === "OURS_USAGE_REPAIR") {
    // Minimal: reuse any-stub for repair modes, and report repair metrics at aggregate level as zeros.
    return await generateAnyStubDts(
      sc.libraryName,
      path.join(conditionOutDir, "generated-dts", "OURS_REPAIR"),
      mode.includes("USAGE") ? sc.consumerPath : undefined,
    );
  }
  // fallback: scenario's own predicted path
  return sc.predictedDtsPath;
}

async function generateAnyStubDts(libName, baseDir, consumerPath) {
  const dir = path.join(baseDir, libName);
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, "index.d.ts");
  const named = consumerPath
    ? await extractNamedImportsFromConsumer(consumerPath, libName)
    : [];
  const exportLines = named.map((n) => `  export const ${n}: any;`).join("\n");
  const exportStyle = exportLines
    ? `  const _default: any;\n  export default _default;\n`
    : `  const _default: any;\n  export = _default;\n`;
  const content =
    `declare module "${libName}" {\n` +
    (exportLines ? `${exportLines}\n` : "") +
    exportStyle +
    `}\n`;
  await fs.writeFile(outPath, content, "utf8");
  return outPath;
}

async function extractNamedImportsFromConsumer(consumerPath, libName) {
  try {
    const files = await glob("**/*.ts", { cwd: consumerPath, absolute: true });
    const names = new Set();
    const re = new RegExp(
      String.raw`import\s+\{([^}]+)\}\s+from\s+["']${escapeRegExp(libName)}["']`,
      "g",
    );
    for (const f of files) {
      const txt = await fs.readFile(f, "utf8");
      let m;
      while ((m = re.exec(txt)) !== null) {
        const inside = m[1];
        for (const part of inside.split(",")) {
          const cleaned = part.trim();
          if (!cleaned) continue;
          // handle alias: a as b
          const aliasParts = cleaned.split(/\s+as\s+/i).map((s) => s.trim());
          const name = aliasParts[1] || aliasParts[0];
          if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.add(name);
        }
      }
    }
    return Array.from(names).sort();
  } catch {
    return [];
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildAggregate(expOutDir, conditionIds) {
  const conditions = [];
  const overallErrorCounts = {};
  let totalWallTimeMs = 0;

  for (const cid of conditionIds) {
    const summaryPath = path.join(expOutDir, cid, "summary.json");
    if (!existsSync(summaryPath)) continue;
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    const resultsPath = path.join(expOutDir, cid, "results.eval.jsonl");
    const rows = existsSync(resultsPath)
      ? (await fs.readFile(resultsPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const predictedRows = rows.filter((r) => r.mode === "predicted");
    const passed = predictedRows.filter((r) => r.status === "success").length;
    const total = predictedRows.length;
    const failed = total - passed;

    for (const r of predictedRows) {
      if (r.errorCode) {
        overallErrorCounts[r.errorCode] = (overallErrorCounts[r.errorCode] ?? 0) + 1;
      }
      totalWallTimeMs += r.durationMs ?? 0;
    }

    const isRepairMode = String(summary.condition?.mode ?? "").includes("REPAIR");
    conditions.push({
      conditionId: cid,
      mode: summary.condition?.mode,
      success_rate: summary.metrics?.predicted_success_rate ?? (total ? passed / total : 0),
      total,
      passed,
      failed,
      repair: isRepairMode
        ? {
            iters_used: 0,
            tsc_runs: total * 2, // baseline+predicted; minimal placeholder
            wall_time_ms: predictedRows.reduce((a, r) => a + (r.durationMs ?? 0), 0),
          }
        : undefined,
    });
  }

  const topErrorCodes = Object.entries(overallErrorCounts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    conditions,
    error_code_top: topErrorCodes,
    wall_time_ms: totalWallTimeMs,
  };
}

async function legacyEval(opts) {
  const timestamp = formatTimestamp(new Date());
  const runDir = path.resolve(process.cwd(), "runs", opts.repair ? `${timestamp}-repair` : `${timestamp}-harness`);
  const logsDir = path.join(runDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const projectPaths = await glob(opts.projectsPattern, { absolute: true });
  if (projectPaths.length === 0) {
    console.error(`No projects matched pattern: ${opts.projectsPattern}`);
    process.exitCode = 1;
    return;
  }

  if (!opts.repair) {
    const results = [];
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
    return;
  }

  const baselineOut = [];
  const repairedOut = [];
  const cache = new Map();

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath);
    const predictionPath = path.resolve(process.cwd(), "predictions", `${projectName}.json`);
    const hasPreds = existsSync(predictionPath);

    if (!hasPreds) {
      const baseline = await runProjectLegacy(projectPath, opts, logsDir);
      baselineOut.push({ ...baseline, phase: "baseline" });
      repairedOut.push({ ...baseline, phase: "repaired" });
      continue;
    }

    const preds = JSON.parse(await fs.readFile(predictionPath, "utf8"));
    const baseline = await evalWithAssignment({
      projectPath,
      projectName,
      opts,
      logsDir,
      runDir,
      preds,
      assignment: initialAssignment(preds, opts.topk),
      cache,
      logSuffix: "baseline",
    });
    baselineOut.push(baseline);

    const repaired = await repairProject({
      baseline,
      projectPath,
      projectName,
      preds,
      opts,
      logsDir,
      runDir,
      cache,
    });
    repairedOut.push(repaired);
  }

  const baselinePath = path.join(runDir, "results.baseline.jsonl");
  const repairedPath = path.join(runDir, "results.repaired.jsonl");
  await fs.writeFile(baselinePath, baselineOut.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await fs.writeFile(repairedPath, repairedOut.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nSaved baseline to ${path.relative(process.cwd(), baselinePath)}`);
  console.log(`Saved repaired to ${path.relative(process.cwd(), repairedPath)}`);
}

function initialAssignment(preds, topk) {
  const assignment = {};
  for (const s of preds.slots ?? []) {
    assignment[s.slotId] = 0;
  }
  return assignment;
}

function isTrivialType(t) {
  const s = String(t).trim();
  return (
    s === "any" ||
    s === "Function" ||
    s === "any[]" ||
    s === "unknown" ||
    s === "object"
  );
}

function assignmentKey(assignment) {
  const keys = Object.keys(assignment).sort();
  return keys.map((k) => `${k}=${assignment[k]}`).join("&");
}

function countErrors(output) {
  if (!output) return 0;
  const matches = output.match(/error TS\d{4}:/g);
  return matches ? matches.length : 0;
}

function parseDiagnostics(output, cwd) {
  const diags = [];
  if (!output) return diags;
  const lines = output.split(/\r?\n/);
  const re = /^(.*)\((\d+),(\d+)\): error (TS\d{4}):/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const filePathRaw = m[1];
    const filePath = path.isAbsolute(filePathRaw)
      ? filePathRaw
      : path.resolve(cwd, filePathRaw);
    diags.push({
      filePath,
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      text: line,
    });
  }
  return diags;
}

async function evalWithAssignment(args) {
  const { projectPath, projectName, opts, logsDir, runDir, preds, assignment, cache, logSuffix } = args;
  const key = `${projectName}|${assignmentKey(assignment)}|k=${opts.topk}|pen=${opts.trivialPenalty}`;
  if (cache.has(key)) return { ...cache.get(key), fromCache: true };

  const logPath = path.join(logsDir, `${logSuffix}-${sanitizeFileName(projectName)}.log`);
  await fs.writeFile(logPath, "");

  const dtsDir = path.join(runDir, "generated-dts", projectName);
  await fs.mkdir(dtsDir, { recursive: true });
  const dtsPath = path.join(dtsDir, "index.d.ts");
  const { content, slotLineMap } = buildDtsFromPreds(preds, assignment);
  await fs.writeFile(dtsPath, content, "utf8");

  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  const normalization = await normalizeTsconfig(tsconfigPath);
  let injectedTsconfig;
  try {
    injectedTsconfig = await writeInjectedTsconfig(projectPath, preds.libName, dtsPath);
    const started = Date.now();
    const { exitCode, stdout, stderr, timedOut } = await runCommand(
      `${getTscCliCommand()} --noEmit -p "${injectedTsconfig}"`,
      projectPath,
      opts.timeoutSec,
      logPath,
    );
    const durationMs = Date.now() - started;
    const combined = (stderr || "") + (stdout || "");
    const errorCode = firstErrorCode(combined);
    const status = classify(exitCode, errorCode, timedOut);
    const stderrHead = status === "success" ? undefined : head(combined, opts.headLines);
    const diagnostics = parseDiagnostics(combined, projectPath);
    const errorCount = countErrors(combined);
    const trivialCount = countTrivialSelected(preds, assignment);
    const score = computeScore(status, errorCount, trivialCount, opts.trivialPenalty);

    const result = {
      project: projectPath,
      projectName,
      status,
      exitCode,
      errorCode: status === "success" ? undefined : errorCode,
      stderr_head: stderrHead,
      normalized: normalization.normalized,
      tsconfigPath,
      durationMs,
      condition: "repair",
      libName: preds.libName,
      injectedDtsPath: dtsPath,
      injectionMode: "tsconfig.injected",
      assignment,
      score,
      errorCount,
      trivialCount,
      slotLineMap,
      diagnostics,
      logPath,
      phase: logSuffix,
    };
    cache.set(key, result);
    return result;
  } finally {
    await normalization.restore();
    if (injectedTsconfig) await fs.rm(injectedTsconfig, { force: true });
  }
}

function computeScore(status, errorCount, trivialCount, penaltyWeight) {
  const penalty = (penaltyWeight ?? 0) * (trivialCount ?? 0);
  if (status === "success") return 0 + penalty;
  return (errorCount ?? 9999) + penalty;
}

function countTrivialSelected(preds, assignment) {
  let c = 0;
  for (const s of preds.slots ?? []) {
    const idx = assignment[s.slotId] ?? 0;
    const cand = (s.candidates ?? [])[idx];
    if (cand && isTrivialType(cand.type)) c++;
  }
  return c;
}

function buildDtsFromPreds(preds, assignment) {
  const lines = [];
  const slotLineMap = {};
  lines.push(`declare module "${preds.libName}" {`);
  let lineNo = 1;
  lineNo++;
  for (const exp of preds.exports ?? []) {
    if (exp.kind !== "function") continue;
    // params
    const params = (exp.params ?? []).map((p, idx) => {
      const slotId = `${exp.name}:param:${idx}`;
      const cand = pickCandidate(preds, slotId, assignment);
      // keep one-line param list; slot comment before function line
      return `${p}: ${cand.type}`;
    });
    // return
    const returnSlot = `${exp.name}:return`;
    const ret = pickCandidate(preds, returnSlot, assignment);

    // slot comment line maps to itself and the next line (where errors likely point)
    const slotComment = `  // @slot:${returnSlot}`;
    lines.push(slotComment);
    lineNo++;
    slotLineMap[returnSlot] = { commentLine: lineNo - 1, declLine: lineNo };

    const fnLine = `  export function ${exp.name}(${params.join(", ")}): ${ret.type};`;
    lines.push(fnLine);
    lineNo++;
  }
  lines.push("}");
  return { content: lines.join("\n") + "\n", slotLineMap };
}

function pickCandidate(preds, slotId, assignment) {
  const slot = (preds.slots ?? []).find((s) => s.slotId === slotId);
  const idx = assignment[slotId] ?? 0;
  const cand = slot?.candidates?.[idx];
  if (!cand || !cand.type) return { type: "any", score: 0 };
  return cand;
}

async function writeInjectedTsconfig(projectDir, libName, dtsPath) {
  const injectedPath = path.join(projectDir, "tsconfig.injected.json");
  const dir = path.dirname(dtsPath);
  const injected = {
    extends: "./tsconfig.json",
    compilerOptions: {
      baseUrl: ".",
      paths: {
        [libName]: [dtsPath],
        [`${libName}/*`]: [path.join(dir, "*")],
      },
    },
  };
  await fs.writeFile(injectedPath, JSON.stringify(injected, null, 2));
  return injectedPath;
}

function chooseSlotToFix(current, preds, result) {
  const dtsPath = current.injectedDtsPath;
  // 1) prioritize diagnostics pointing to generated dts
  for (const d of current.diagnostics ?? []) {
    if (!dtsPath) continue;
    if (d.filePath !== dtsPath) continue;
    const slotId = Object.keys(current.slotLineMap ?? {}).find((sid) => {
      const m = current.slotLineMap[sid];
      return m && (m.declLine === d.line || m.commentLine === d.line);
    });
    if (slotId) return slotId;
  }
  // 2) fallback: lowest confidence (small score gap)
  const candidates = [];
  for (const s of preds.slots ?? []) {
    const c0 = s.candidates?.[0]?.score ?? 0;
    const c1 = s.candidates?.[1]?.score ?? -Infinity;
    const gap = c0 - c1;
    candidates.push({ slotId: s.slotId, gap });
  }
  candidates.sort((a, b) => a.gap - b.gap);
  return candidates[0]?.slotId;
}

async function repairProject(args) {
  const { baseline, projectPath, projectName, preds, opts, logsDir, runDir, cache } = args;
  if (baseline.status === "success") return { ...baseline, phase: "repaired", repaired: true };
  if (baseline.status !== "type_error") return { ...baseline, phase: "repaired", repaired: false };

  let current = baseline;
  const exhausted = new Set();
  for (let iter = 0; iter < opts.maxIters; iter++) {
    const slotId = chooseSlotToFix(current, preds, current);
    if (!slotId || exhausted.has(slotId)) break;

    const slot = (preds.slots ?? []).find((s) => s.slotId === slotId);
    const k = Math.min(opts.topk, slot?.candidates?.length ?? 0);
    if (k <= 1) {
      exhausted.add(slotId);
      continue;
    }

    let best = current;
    let improved = false;
    for (let candIdx = 1; candIdx < k; candIdx++) {
      const nextAssign = { ...current.assignment, [slotId]: candIdx };
      const r = await evalWithAssignment({
        projectPath,
        projectName,
        opts,
        logsDir,
        runDir,
        preds,
        assignment: nextAssign,
        cache,
        logSuffix: "repaired",
      });
      if (r.score < best.score) {
        best = r;
        improved = true;
      }
      if (best.status === "success") break;
    }

    if (best.status === "success") return { ...best, phase: "repaired", repaired: true, iters: iter + 1 };
    if (!improved) exhausted.add(slotId);
    else current = best;
  }
  return { ...current, phase: "repaired", repaired: current.status === "success" };
}

async function readManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, "utf8");
  const data = JSON.parse(raw);
  if (!data.workspaceDir || !data.projects) {
    throw new Error("manifest missing workspaceDir or projects");
  }
  return data;
}

async function readLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  const raw = await fs.readFile(lockPath, "utf8");
  return JSON.parse(raw);
}

async function writeLock(lockPath, projects) {
  const lock = { projects };
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
}

function findLockCommit(lock, name) {
  return lock?.projects.find((p) => p.name === name)?.resolvedCommit;
}

function resolveProjectRoot(manifestDir, workspaceDir, project) {
  if (project.source.type === "local") {
    return path.resolve(manifestDir, project.source.path);
  }
  const base = path.resolve(manifestDir, workspaceDir);
  return path.join(base, project.name);
}

async function prepareGitProject(args) {
  const { project, targetDir, desiredRef, logPath } = args;

  const cloneOrFetch = existsSync(targetDir)
    ? ["git", ["-C", targetDir, "fetch", "--all", "--tags", "--prune"]]
    : ["git", ["clone", project.source.repo, targetDir]];

  const fetchRes = await runCommandArray(cloneOrFetch[0], cloneOrFetch[1], process.cwd(), 300, logPath);
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

async function ensureGitCheckout(args) {
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
  project,
  workDir,
  timeoutSec,
  headLines,
  logPath,
  conditionOpts,
) {
  const tsconfigPath = path.join(workDir, "tsconfig.json");
  let normalized = false;
  let restoreFn;
  let injectedTsconfig;
  let injectionMode;

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
  workDir,
  conditionOpts,
  tsconfigPath,
  setInjected,
) {
  if (!conditionOpts.libName || !conditionOpts.dtsPath) {
    throw new Error("BL1 requires --libName and --dts (or auto-generated)");
  }
  const injectedPath = path.join(workDir, "tsconfig.injected.json");
  const paths = {};
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
  return `npx tsc --noEmit -p "${injectedPath}"`;
}

async function runProjectLegacy(
  projectPath,
  opts,
  logsDir,
) {
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
      condition: "legacy",
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
      condition: "legacy",
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
      condition: "legacy",
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

async function generateBaselineDts(libName) {
  const outDir = path.resolve(process.cwd(), "generated-dts", "BL1", libName);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.d.ts");
  const content = `declare module "${libName}" {\n  const _default: any;\n  export = _default;\n}\nexport {};\n`;
  await fs.writeFile(outPath, content, "utf8");
  return outPath;
}

function buildSummary(
  results,
  conditionInfo,
) {
  const metrics = {
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
  return runCommand(`${getTscCliCommand()} --noEmit`, cwd, timeoutSec, logPath);
}

function runCommand(
  command,
  cwd,
  timeoutSec,
  logPath,
) {
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
  command,
  args,
  cwd,
  timeoutSec,
  logPath,
) {
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

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

