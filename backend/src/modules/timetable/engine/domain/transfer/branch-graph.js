// PHASE 26 — branch graph audit.
//
// A read-only view of the branch graph that the transfer / travel
// pipeline can consult. Phase 26 NEVER adds edges to this graph
// (no travel data is fabricated). The graph is just an audit
// snapshot of the branches the scheduling input knows about.
//
//   {
//     id,         // branch id
//     code,       // short code (e.g. "PH1")
//     name,       // human-readable name
//     active,     // boolean — phase 26 reports but does not filter
//     schoolDays, // number of school days
//     periods,    // number of periods
//   }
//
// The graph is the seed of any future travel topology. Today, no
// travel edge exists; the graph is just a node list. When a real
// travel matrix arrives, edges can be attached to this node list
// without changing the contract this module exposes.

/**
 * Build a branch graph from a list of branch records.
 * Each input branch is expected to carry at minimum:
 *   id, code, name, isActive, schoolDays[], periods[].
 * Missing fields fall back to safe defaults (no fabrication):
 *   code        = ''            (empty)
 *   name        = ''            (empty)
 *   isActive    = true          (default; not invented)
 *   schoolDays  = []
 *   periods     = []
 *
 * The function is pure. Same input → same output.
 */
export function buildBranchGraph(branches) {
  if (!Array.isArray(branches)) return [];
  return branches.map((b) => {
    if (!b || typeof b !== 'object') return null;
    return {
      id: b.id ?? null,
      code: typeof b.code === 'string' ? b.code : '',
      name: typeof b.name === 'string' ? b.name : '',
      active: b.isActive !== false, // undefined / missing treated as true
      schoolDays: Array.isArray(b.schoolDays) ? b.schoolDays.length : 0,
      periods: Array.isArray(b.periods) ? b.periods.length : 0,
    };
  }).filter((n) => n && n.id != null);
}

/**
 * Index the branch graph by id for O(1) lookup. The index never
 * adds edges; it is just a name table.
 */
export function indexBranchGraph(graph) {
  const out = new Map();
  for (const node of graph) {
    if (node?.id != null) out.set(node.id, node);
  }
  return out;
}

/**
 * Resolve a branch id against the graph. Returns:
 *   { status: 'RESOLVED',   node }
 *   { status: 'UNKNOWN',    id }   (id not in graph)
 *   { status: 'INACTIVE',   node } (id in graph but not active)
 *
 * The function NEVER fabricates a node. It NEVER throws on a
 * missing id; the caller decides what to do with the report.
 */
export function resolveBranchId(branchId, graph) {
  if (branchId == null) {
    return { status: 'UNKNOWN', id: null };
  }
  const node = graph.find((n) => n.id === branchId) ?? null;
  if (!node) return { status: 'UNKNOWN', id: branchId };
  if (!node.active) return { status: 'INACTIVE', node };
  return { status: 'RESOLVED', node };
}

/**
 * Resolve a list of branch ids. The result is a structured report
 * suitable for direct serialization in a Phase 26 audit.
 */
export function resolveBranchIds(branchIds, graph) {
  if (!Array.isArray(branchIds)) return { resolved: [], inactive: [], unknown: [] };
  const resolved = [];
  const inactive = [];
  const unknown = [];
  for (const id of branchIds) {
    const r = resolveBranchId(id, graph);
    if (r.status === 'RESOLVED') resolved.push(r.node.id);
    else if (r.status === 'INACTIVE') inactive.push(r.node.id);
    else unknown.push(id);
  }
  return { resolved, inactive, unknown };
}
