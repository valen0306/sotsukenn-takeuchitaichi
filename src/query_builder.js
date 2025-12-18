export function buildQueries(surface) {
  const queries = [];
  for (const item of surface.exports) {
    if (item.kind !== "function") continue;
    const params = item.params ?? [];
    const paramMasks = params.map((_, idx) => `[MASK_${idx}]`);

    // param slots
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

    // return slot
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

