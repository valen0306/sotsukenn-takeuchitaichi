export interface ApiSurface {
  libName: string;
  exports: Array<{
    kind: "function";
    name: string;
    params: string[];
  }>;
}

export interface Query {
  id: string;
  query: string;
  target: { name: string; slot: string };
}

export function buildQueries(surface: ApiSurface): Query[] {
  const queries: Query[] = [];
  for (const item of surface.exports) {
    if (item.kind !== "function") continue;
    const params = item.params ?? [];
    const parts = params.map((p, idx) => `${p}: [MASK_${idx}]`);
    const paramMasks = params.map((_, idx) => `[MASK_${idx}]`);
    for (let i = 0; i < params.length; i++) {
      const maskedParams = params.map((p, idx) =>
        idx === i ? `${p}: [MASK]` : `${p}: ${paramMasks[idx]}`,
      );
      const q = `declare function ${item.name}(${maskedParams.join(", ")}): [MASK_RETURN];`;
      queries.push({
        id: `${item.name}:param:${i}`,
        query: q,
        target: { name: item.name, slot: `param_${i}` },
      });
    }
    const maskedParams = params.map((p, idx) => `${p}: ${paramMasks[idx]}`);
    const q = `declare function ${item.name}(${maskedParams.join(", ")}): [MASK];`;
    queries.push({
      id: `${item.name}:return`,
      query: q,
      target: { name: item.name, slot: "return" },
    });
  }
  return queries;
}

