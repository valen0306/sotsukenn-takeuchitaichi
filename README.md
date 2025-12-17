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

