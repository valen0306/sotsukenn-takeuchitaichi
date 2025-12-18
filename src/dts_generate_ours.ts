import fs from "node:fs/promises";
import path from "node:path";
import { buildQueries, ApiSurface, Query } from "./query_builder.js";
import { PythonPredictor } from "./predictor_python.js";
import { Prediction } from "./predictor.js";

export interface GenDtsOptions {
  apiPath: string;
  outDir: string;
}

export interface GenDtsResult {
  libName: string;
  generatedDtsPath: string;
  queriesPath: string;
}

export async function genDts(options: GenDtsOptions): Promise<GenDtsResult> {
  const surface = await readApiSurface(options.apiPath);
  const queries = buildQueries(surface);
  const queriesDir = path.resolve(process.cwd(), "generated-queries");
  await fs.mkdir(queriesDir, { recursive: true });
  const queriesPath = path.join(queriesDir, `${surface.libName}.jsonl`);
  await writeJsonl(queriesPath, queries);

  const predictor = new PythonPredictor();
  const predictions = await predictor.predict(
    queries.map((q) => ({ id: q.id, query: q.query })),
  );

  const outDir = path.resolve(options.outDir, surface.libName);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.d.ts");
  const content = buildDts(surface, queries, predictions);
  await fs.writeFile(outPath, content, "utf8");

  return {
    libName: surface.libName,
    generatedDtsPath: outPath,
    queriesPath,
  };
}

async function readApiSurface(apiPath: string): Promise<ApiSurface> {
  const raw = await fs.readFile(path.resolve(apiPath), "utf8");
  return JSON.parse(raw) as ApiSurface;
}

async function writeJsonl(filePath: string, items: Query[]): Promise<void> {
  const lines = items.map((q) => JSON.stringify(q)).join("\n") + "\n";
  await fs.writeFile(filePath, lines, "utf8");
}

function findType(predictions: Prediction[], id: string): string | undefined {
  return predictions.find((p) => p.id === id)?.type;
}

function buildDts(surface: ApiSurface, queries: Query[], predictions: Prediction[]): string {
  const lines: string[] = [];
  lines.push(`declare module "${surface.libName}" {`);
  for (const item of surface.exports) {
    if (item.kind !== "function") continue;
    const params = item.params.map((p, idx) => {
      const t =
        findType(predictions, `${item.name}:param:${idx}`) ??
        "any";
      return `${p}: ${t}`;
    });
    const ret =
      findType(predictions, `${item.name}:return`) ??
      "any";
    lines.push(`  export function ${item.name}(${params.join(", ")}): ${ret};`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

