import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function latestRepairRunDir() {
  const runsDir = path.resolve(process.cwd(), "runs");
  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith("-repair"))
    .map((e) => path.join(runsDir, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

function readJsonl(filePath) {
  const txt = fs.readFileSync(filePath, "utf8").trim();
  if (!txt) return [];
  return txt.split("\n").map((l) => JSON.parse(l));
}

test("repair loop can fix type_error by switching candidates (prefers non-trivial over any)", async () => {
  // ensure fixture deps installed for typecheck
  // (tests assume user ran pnpm -C fixtures/repair-project i already; otherwise tsc may be missing)

  execFileSync("node", [
    "run.js",
    "--projects",
    "./fixtures/repair-project",
    "--repair",
    "--topk",
    "3",
    "--maxIters",
    "10",
    "--beam",
    "1",
    "--trivialPenalty",
    "5",
  ], { stdio: "inherit" });

  const runDir = latestRepairRunDir();
  assert.ok(runDir, "expected a -repair run directory");

  const baseline = readJsonl(path.join(runDir, "results.baseline.jsonl"));
  const repaired = readJsonl(path.join(runDir, "results.repaired.jsonl"));
  assert.equal(baseline.length, 1);
  assert.equal(repaired.length, 1);

  assert.equal(baseline[0].status, "type_error");
  assert.equal(repaired[0].status, "success");

  // should pick candidate index 1 ({ foo: number }) rather than any (index 2)
  assert.equal(repaired[0].assignment["getX:return"], 1);
});


