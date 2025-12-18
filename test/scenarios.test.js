import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function ensureFixtureNodeModules() {
  const consumer = path.resolve(process.cwd(), "fixtures", "consumer-strict");
  const lib = path.resolve(process.cwd(), "fixtures", "lib-no-types");

  const nmLibDir = path.join(consumer, "node_modules", "lib-no-types");
  fs.mkdirSync(nmLibDir, { recursive: true });
  fs.copyFileSync(path.join(lib, "package.json"), path.join(nmLibDir, "package.json"));
  fs.copyFileSync(path.join(lib, "index.js"), path.join(nmLibDir, "index.js"));
}

function latestScenarioRunDir() {
  const runsDir = path.resolve(process.cwd(), "runs");
  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith("-scenarios"))
    .map((e) => path.join(runsDir, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

function readJsonl(filePath) {
  const txt = fs.readFileSync(filePath, "utf8").trim();
  if (!txt) return [];
  return txt.split("\n").map((l) => JSON.parse(l));
}

test("scenario eval: baseline fails with TS7016 and predicted succeeds after @types injection", async () => {
  ensureFixtureNodeModules();

  execFileSync("node", ["run.js", "eval", "--scenarios", "./scenarios/*.json"], { stdio: "inherit" });

  const runDir = latestScenarioRunDir();
  assert.ok(runDir, "expected a -scenarios run directory");

  const rows = readJsonl(path.join(runDir, "results.eval.jsonl"));
  const baseline = rows.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "baseline");
  const predicted = rows.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "predicted");

  assert.ok(baseline);
  assert.ok(predicted);
  assert.equal(baseline.status, "type_error");
  assert.equal(baseline.errorCode, "TS7016");
  assert.equal(predicted.status, "success");
});

test("scenario eval restores injected @types and summary.json rates are correct (run twice)", async () => {
  ensureFixtureNodeModules();

  const consumer = path.resolve(process.cwd(), "fixtures", "consumer-strict");
  const injectedPath = path.join(consumer, "node_modules", "@types", "lib-no-types", "index.d.ts");

  // Run 1
  execFileSync("node", ["run.js", "eval", "--scenarios", "./scenarios/*.json"], { stdio: "inherit" });
  const runDir1 = latestScenarioRunDir();
  const rows1 = readJsonl(path.join(runDir1, "results.eval.jsonl"));
  const baseline1 = rows1.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "baseline");
  const predicted1 = rows1.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "predicted");
  assert.equal(baseline1.status, "type_error");
  assert.equal(baseline1.errorCode, "TS7016");
  assert.equal(predicted1.status, "success");

  // Injection should be cleaned up (no original @types existed).
  assert.equal(fs.existsSync(injectedPath), false);

  const summary1 = JSON.parse(fs.readFileSync(path.join(runDir1, "summary.json"), "utf8"));
  assert.equal(summary1.metrics.baseline_success_rate, 0);
  assert.equal(summary1.metrics.predicted_success_rate, 1);
  assert.equal(summary1.metrics.delta, 1);

  // Run 2 (should be identical because no residue)
  execFileSync("node", ["run.js", "eval", "--scenarios", "./scenarios/*.json"], { stdio: "inherit" });
  const runDir2 = latestScenarioRunDir();
  const rows2 = readJsonl(path.join(runDir2, "results.eval.jsonl"));
  const baseline2 = rows2.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "baseline");
  const predicted2 = rows2.find((r) => r.scenarioId === "fixture-lib-no-types" && r.mode === "predicted");
  assert.equal(baseline2.status, "type_error");
  assert.equal(baseline2.errorCode, "TS7016");
  assert.equal(predicted2.status, "success");
  assert.equal(fs.existsSync(injectedPath), false);
});


