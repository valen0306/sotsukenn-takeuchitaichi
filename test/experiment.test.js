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

test("experiment runs matrix and writes aggregate.json with expected success rates", async () => {
  ensureFixtureNodeModules();

  const outDir = path.resolve(process.cwd(), "runs", "test-exp");
  fs.rmSync(outDir, { recursive: true, force: true });

  execFileSync(
    "node",
    [
      "run.js",
      "experiment",
      "--scenarios",
      "./scenarios/*.json",
      "--matrix",
      "experiments/matrix.example.json",
      "--out",
      outDir,
    ],
    { stdio: "inherit" },
  );

  const aggregatePath = path.join(outDir, "aggregate.json");
  assert.ok(fs.existsSync(aggregatePath));
  const agg = JSON.parse(fs.readFileSync(aggregatePath, "utf8"));

  const bl0 = agg.conditions.find((c) => c.conditionId === "BL0");
  const bl1 = agg.conditions.find((c) => c.conditionId === "BL1");
  assert.ok(bl0);
  assert.ok(bl1);

  // With 1 scenario: BL0 predicted runs without injection -> fails; BL1 predicted injects any-stub -> succeeds.
  assert.equal(bl0.total, 1);
  assert.equal(bl1.total, 1);
  assert.equal(bl0.passed, 0);
  assert.equal(bl1.passed, 1);
  assert.equal(bl0.success_rate, 0);
  assert.equal(bl1.success_rate, 1);

  // resume should skip conditions (no error)
  execFileSync(
    "node",
    [
      "run.js",
      "experiment",
      "--scenarios",
      "./scenarios/*.json",
      "--matrix",
      "experiments/matrix.example.json",
      "--out",
      outDir,
      "--resume",
    ],
    { stdio: "inherit" },
  );
});


