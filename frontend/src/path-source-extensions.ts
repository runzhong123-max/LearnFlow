import { OFFICIAL_PATH_NAMESPACE, pathNodeKey, type LearningPathGraphV2, type PathNodeKey, type PathNodeV2 } from './learning-path-contract-v2.ts'

/** Source adjacency only: containment never supplies a learner status or prerequisite. */
export function projectPathSourceExtensions(graph: LearningPathGraphV2, officialId?: string) {
  const allNodes = new Map(graph.nodes.map(node => [pathNodeKey(node), node]))
  const extensions = graph.nodes.filter(node => node.ownership.catalog === 'graph_extension' && (node.kind === 'knowledge' || node.kind === 'skill'))
  const children = new Map<string, PathNodeV2[]>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') continue
    const child = allNodes.get(pathNodeKey(edge.to))
    if (child) children.set(pathNodeKey(edge.from), [...(children.get(pathNodeKey(edge.from)) || []), child])
  }
  const reachable = new Set<string>()
  function visit(key: PathNodeKey) {
    const id = pathNodeKey(key)
    if (reachable.has(id)) return
    reachable.add(id)
    for (const child of children.get(id) || []) visit(child)
  }
  if (officialId) visit({ namespace: OFFICIAL_PATH_NAMESPACE, id: officialId })
  const attached = extensions.filter(node => reachable.has(pathNodeKey(node)))
  const parents = (node: PathNodeV2) => graph.edges.filter(edge => edge.kind === 'contains' && pathNodeKey(edge.to) === pathNodeKey(node)).flatMap(edge => {
    const parent = allNodes.get(pathNodeKey(edge.from)); return parent ? [parent] : []
  })
  return { extensions, attached, parents }
}
