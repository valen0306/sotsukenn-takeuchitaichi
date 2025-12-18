# Type-check Metrics CLI (Step 1)

TypeScript/Node CLI that measures project-level type-check success (RQ1). It runs `tsc --noEmit` (or any provided command) for each downstream project, logs results, and saves a summary.

## Setup

1) Install Node.js 18+.  
2) Install dependencies (pnpm recommended):

```bash
pnpm install
```

## Configuration

- Copy `config.example.json` to `config.json` and edit.
- `workspaceDir` is resolved relative to the config file location.
- Each project entry:
  - `name`: label used in the summary/log file name.
  - `path`: path to the project root (absolute or relative to `workspaceDir`).
  - `packageManager`: optional note for humans (not used yet).
  - `tscCommand`: command to run (e.g., `pnpm -s tsc --noEmit` or `npx tsc --noEmit`).
- `timeoutSec`: per-project timeout; timeout is treated as failure.

Example:

```json
{
  "workspaceDir": "./workspace",
  "timeoutSec": 120,
  "projects": [
    {
      "name": "sample-project",
      "path": "sample-project",
      "packageManager": "pnpm",
      "tscCommand": "pnpm -s tsc --noEmit"
    }
  ]
}
```

## Run

```bash
pnpm start -- --config ./config.json
```

Outputs:
- `runs/<timestamp>/logs/<project>.log` — stdout/stderr from the command.
- `runs/<timestamp>/summary.json` — metrics and failure reasons.

Console prints a brief summary after the run.

## Manifest-based workflow (prepare & eval)

`experiments/manifest.json` で下流プロジェクト群を固定・再現できます（例: `experiments/manifest.example.json`）。

- **prepare**: gitプロジェクトの clone/fetch + checkout + install を実行し、実際の commit を `experiments/lock.json` に記録
- **eval**: lock があればその commit を優先して checkout し、typecheck を実行（tsconfig 正規化・分類・results.jsonl 出力は従来どおり）

手順:

```bash
# マニフェストを指定して準備
node run.js prepare --manifest experiments/manifest.json

# 評価を実行（結果は runs/<timestamp>-eval/ 配下）
node run.js eval --manifest experiments/manifest.json
```

ログ/成果物:
- Prepare: `runs/<timestamp>/prepare-logs/<project>.log`
- Eval: `runs/<timestamp>-eval/logs/<project>.log`, `runs/<timestamp>-eval/results.jsonl`
- Lock: `experiments/lock.json`（再現性のため再実行時もこの commit を checkout）

### BL0 / BL1（.d.ts 注入比較）

- BL0: 注入なしのベースライン
- BL1: `--libName` で指定したライブラリ名を `paths` に向ける形で .d.ts を注入（`--dts` 未指定なら `generated-dts/BL1/<lib>/index.d.ts` を自動生成）

実行例:

```bash
# BL0（注入なし）
node run.js eval --manifest experiments/manifest.json --condition BL0

# BL1（libName=foo用の .d.ts を注入）
node run.js eval --manifest experiments/manifest.json --condition BL1 --libName foo --dts /absolute/path/to/foo.d.ts

# BL1（--dts 省略時は dummy を自動生成）
node run.js eval --manifest experiments/manifest.json --condition BL1 --libName foo
```

results.jsonl には `condition`, `libName`, `injectedDtsPath`, `injectionMode` が出力され、`summary.json` にも condition が含まれます。注入は `tsconfig.injected.json` を一時生成する方式で、実行後は元の tsconfig を復元します。

### OURS（TypeBERTダミー予測での .d.ts 生成）

固定ファイルの API surface (`experiments/api-surface.json`) からクエリを作り、Pythonブリッジ（`scripts/predict.py` はダミーで常に any）経由で予測 → `generated-dts/OURS/<lib>/index.d.ts` を生成します。

```bash
# クエリ生成 + 予測 + d.ts生成
node run.js gen-dts --api experiments/api-surface.json --out generated-dts/OURS

# 生成した d.ts を注入して評価（条件 OURS）
node run.js eval --manifest experiments/manifest.json --condition OURS \
  --libName fixtures-lib \
  --dts generated-dts/OURS/fixtures-lib/index.d.ts
```

`generated-queries/<lib>.jsonl` にクエリが保存され、`results.jsonl` には `condition=OURS`, `libName`, `injectedDtsPath`, `injectionMode` が記録されます。

## Phase 5 (RQ1): scenario-based downstream evaluation

`scenarios/*.json` を入力として、各 scenario について **baseline（注入なし）** と **predicted（.d.ts 注入あり）** を実行します。

### Scenario format

各ファイルは以下の形です:

```json
{
  "id": "fixture-lib-no-types",
  "consumerPath": "./fixtures/consumer-strict",
  "libraryName": "lib-no-types",
  "predictedDtsPath": "./fixtures/predicted-dts/lib-no-types/index.d.ts"
}
```

### Run

```bash
node run.js eval --scenarios "./scenarios/*.json"
```

注入方式:
- `consumer/node_modules/@types/<libraryName>/index.d.ts` を一時的に作成/置換し、終了後にバックアップから復元します。

Outputs:
- `runs/<timestamp>-scenarios/results.eval.jsonl`（1実行=1行。scenarioId/mode/status/errorCode/stderr_head/durationMs/node/tsc など）
- `runs/<timestamp>-scenarios/summary.json`（baseline/predicted success率と差分、TSエラーコードの増減トップ）

## Phase 6: experiment matrix runner

複数条件（BL0/BL1/OURSなど）を **一括実行**し、条件間比較用の集計 `aggregate.json` まで自動生成します。

### Matrix format

`experiments/matrix.json`（例: `experiments/matrix.example.json`）:

```json
{
  "conditions": [
    { "id": "BL0", "mode": "BL0" },
    { "id": "BL1", "mode": "BL1" }
  ]
}
```

### Run

```bash
node run.js experiment --scenarios "./scenarios/*.json" --matrix experiments/matrix.json --out runs/my-exp
```

`--resume` を付けると `runs/my-exp/<conditionId>/summary.json` が既にある条件はスキップします。

Outputs:
- `runs/<expId>/<conditionId>/results.eval.jsonl`
- `runs/<expId>/<conditionId>/summary.json`
- `runs/<expId>/aggregate.json`

## Smoke test (fixtures)

Minimal downstream projects are included for quick verification:

```bash
# setup CLI deps
pnpm i

# setup fixtures
pnpm -C fixtures/ok-project i
pnpm -C fixtures/bad-project i

# run evaluation
pnpm start -- --config ./config.json
```

Expected:
- `ok-project` passes type-check.
- `bad-project` fails type-check (intentional type error).
- `runs/<timestamp>/summary.json` is generated with both results.

## What is measured

- A project **passes** if the command exits 0.
- Metrics:
  - `projects_total`, `projects_passed`, `projects_failed`
  - `pass_rate = passed / total`
  - `failed_projects` includes `name`, `reason` (head of log), `log_path`

## Troubleshooting

- Ensure each project has `tsc` available and dependencies installed (`node_modules` present).
- If a project path is wrong or missing, the run will fail fast with a clear reason in the log.
- Increase `timeoutSec` for large projects.

