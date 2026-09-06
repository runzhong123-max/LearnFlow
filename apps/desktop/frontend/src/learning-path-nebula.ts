import type { LearningPathEdge, LearningPathNode, PathStage } from './learning-path-graph'

export type KnowledgeClusterId =
  | 'foundations'
  | 'mathematics'
  | 'hardware'
  | 'systems'
  | 'data'
  | 'software'
  | 'security'
  | 'ai'
  | 'practice'

export type KnowledgeCluster = {
  id: KnowledgeClusterId
  label: string
  caption: string
  color: string
  rgb: string
}

export type KnowledgeStageColumn = {
  id: PathStage
  label: string
  caption: string
  x: number
}

export type NebulaClusterBounds = {
  clusterId: KnowledgeClusterId
  x: number
  y: number
  width: number
  height: number
}

export type NebulaNodePosition = {
  nodeId: string
  clusterId: KnowledgeClusterId
  stage: PathStage
  x: number
  y: number
  width: number
  height: number
  size: number
  degree: number
}

export const NEBULA_WIDTH = 1570
export const NEBULA_STAGE_TOP = 86
const CLUSTER_LEFT = 18
const CLUSTER_WIDTH = NEBULA_WIDTH - 36
const CLUSTER_GAP = 16
const NODE_WIDTH = 112
const NODE_HEIGHT = 38
const NODE_COLUMN_GAP = 10
const NODE_ROW_GAP = 7

export const KNOWLEDGE_STAGE_COLUMNS: KnowledgeStageColumn[] = [
  { id: 'foundation', label: '入门与基础', caption: '共同语言', x: 190 },
  { id: 'core', label: '核心骨架', caption: '专业必需', x: 460 },
  { id: 'domain', label: '专业分流', caption: '方向能力', x: 730 },
  { id: 'advanced', label: '高阶专题', caption: '深入与迁移', x: 1000 },
  { id: 'research', label: '研究与产出', caption: '问题和作品', x: 1270 },
]

export const KNOWLEDGE_CLUSTERS: KnowledgeCluster[] = [
  { id: 'foundations', label: '专业基础', caption: '编程、算法与计算思维', color: '#24765a', rgb: '36,118,90' },
  { id: 'mathematics', label: '数学与理论', caption: '抽象、证明与建模语言', color: '#665fa4', rgb: '102,95,164' },
  { id: 'hardware', label: '硬件与嵌入式', caption: '从逻辑电路到真实设备', color: '#956b32', rgb: '149,107,50' },
  { id: 'systems', label: '系统与云', caption: '资源、并发与大规模运行', color: '#3f708f', rgb: '63,112,143' },
  { id: 'data', label: '数据', caption: '组织、查询与数据工程', color: '#277b79', rgb: '39,123,121' },
  { id: 'software', label: '软件与交互', caption: '构造、架构与用户体验', color: '#4b764f', rgb: '75,118,79' },
  { id: 'security', label: '网络与安全', caption: '连接、攻防与可信边界', color: '#9a4f57', rgb: '154,79,87' },
  { id: 'ai', label: 'AI 与智能体', caption: '学习、生成、决策与行动', color: '#765492', rgb: '118,84,146' },
  { id: 'practice', label: '研究与实践', caption: '用产物和证据完成迁移', color: '#77624d', rgb: '119,98,77' },
]

const clusterById = new Map(KNOWLEDGE_CLUSTERS.map(cluster => [cluster.id, cluster]))
const stageIndex = new Map(KNOWLEDGE_STAGE_COLUMNS.map((stage, index) => [stage.id, index]))

const FOUNDATION_IDS = new Set([
  'digital-literacy', 'computer-introduction', 'computing-ethics', 'programming-foundations',
  'python-programming', 'c-programming', 'object-oriented-programming', 'data-structures', 'algorithms',
])
const PRACTICE_IDS = new Set(['research-methods', 'capstone-project', 'thesis-research'])
const HARDWARE_IDS = new Set(['digital-logic', 'computer-organization', 'embedded-systems'])

export function clusterLearningPathNode(node: LearningPathNode): KnowledgeClusterId {
  if (PRACTICE_IDS.has(node.id) || node.domains.includes('实践') || node.domains.includes('研究') && node.stage === 'research') return 'practice'
  if (FOUNDATION_IDS.has(node.id)) return 'foundations'
  if (HARDWARE_IDS.has(node.id) || node.domains.some(domain => ['硬件', '物联网'].includes(domain))) return 'hardware'
  if (node.domains.some(domain => ['安全', '网络'].includes(domain))) return 'security'
  if (node.domains.some(domain => ['数学', '理论', '算法'].includes(domain))) return 'mathematics'
  if (node.domains.some(domain => ['AI', '智能体', '机器人', '视觉', '语言', '决策'].includes(domain))) return 'ai'
  if (node.domains.some(domain => ['数据'].includes(domain))) return 'data'
  if (node.domains.some(domain => ['系统', '云', '运维', '计算'].includes(domain))) return 'systems'
  return 'software'
}

export function knowledgeCluster(clusterId: KnowledgeClusterId) {
  return clusterById.get(clusterId)!
}

function clusterRowCount(nodes: LearningPathNode[], clusterId: KnowledgeClusterId) {
  const counts = new Map<PathStage, number>()
  nodes.forEach(node => {
    if (clusterLearningPathNode(node) !== clusterId) return
    counts.set(node.stage, (counts.get(node.stage) || 0) + 1)
  })
  return Math.max(1, ...[...counts.values()].map(count => Math.ceil(count / 2)))
}

export function layoutKnowledgeClusters(nodes: LearningPathNode[]) {
  const bounds = new Map<KnowledgeClusterId, NebulaClusterBounds>()
  let y = NEBULA_STAGE_TOP
  KNOWLEDGE_CLUSTERS.forEach(cluster => {
    const rows = clusterRowCount(nodes, cluster.id)
    const height = Math.max(126, 63 + rows * (NODE_HEIGHT + NODE_ROW_GAP))
    bounds.set(cluster.id, {
      clusterId: cluster.id,
      x: CLUSTER_LEFT,
      y,
      width: CLUSTER_WIDTH,
      height,
    })
    y += height + CLUSTER_GAP
  })
  return bounds
}

export function nebulaHeight(nodes: LearningPathNode[]) {
  const bounds = layoutKnowledgeClusters(nodes)
  const last = bounds.get(KNOWLEDGE_CLUSTERS[KNOWLEDGE_CLUSTERS.length - 1].id)!
  return last.y + last.height + 24
}

export function layoutLearningPathNebula(nodes: LearningPathNode[], edges: LearningPathEdge[]) {
  const degree = new Map(nodes.map(node => [node.id, 0]))
  edges.forEach(edge => {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1)
  })
  const bounds = layoutKnowledgeClusters(nodes)
  const positions = new Map<string, NebulaNodePosition>()

  KNOWLEDGE_CLUSTERS.forEach(cluster => {
    const clusterBounds = bounds.get(cluster.id)!
    KNOWLEDGE_STAGE_COLUMNS.forEach(stage => {
      const stageNodes = nodes
        .filter(node => clusterLearningPathNode(node) === cluster.id && node.stage === stage.id)
        .sort((a, b) => a.order - b.order || (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.title.localeCompare(b.title))
      stageNodes.forEach((node, index) => {
        const column = index % 2
        const row = Math.floor(index / 2)
        const x = stage.x + column * (NODE_WIDTH + NODE_COLUMN_GAP)
        const y = clusterBounds.y + 50 + row * (NODE_HEIGHT + NODE_ROW_GAP)
        positions.set(node.id, {
          nodeId: node.id,
          clusterId: cluster.id,
          stage: node.stage,
          x,
          y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          size: NODE_WIDTH,
          degree: degree.get(node.id) || 0,
        })
      })
    })
  })
  return positions
}

export function nebulaEdgePath(from: NebulaNodePosition, to: NebulaNodePosition, edgeId: string) {
  const fromCenterX = from.x + from.width / 2
  const fromCenterY = from.y + from.height / 2
  const toCenterX = to.x + to.width / 2
  const toCenterY = to.y + to.height / 2
  const forward = toCenterX >= fromCenterX
  const x1 = fromCenterX + (forward ? from.width / 2 : -from.width / 2)
  const y1 = fromCenterY
  const x2 = toCenterX + (forward ? -to.width / 2 - 7 : to.width / 2 + 7)
  const y2 = toCenterY
  let hash = 0
  for (let index = 0; index < edgeId.length; index += 1) hash = (hash * 31 + edgeId.charCodeAt(index)) | 0
  if (Math.abs(x2 - x1) < 42) {
    const side = (Math.abs(hash) % 2 ? 1 : -1) * (48 + Math.abs(hash) % 34)
    return `M ${x1} ${y1} C ${x1 + side} ${y1}, ${x2 + side} ${y2}, ${x2} ${y2}`
  }
  const midpoint = (x1 + x2) / 2
  const bend = (Math.abs(hash) % 17) - 8
  return `M ${x1} ${y1} C ${midpoint} ${y1 + bend}, ${midpoint} ${y2 - bend}, ${x2} ${y2}`
}

export function traceLearningPath(edges: LearningPathEdge[], nodeId: string, transitive: boolean) {
  const upstream = new Set<string>([nodeId])
  const downstream = new Set<string>([nodeId])
  const edgeIds = new Set<string>()

  if (!transitive) {
    edges.forEach(edge => {
      if (edge.to === nodeId) {
        upstream.add(edge.from)
        edgeIds.add(edge.id)
      }
      if (edge.from === nodeId) {
        downstream.add(edge.to)
        edgeIds.add(edge.id)
      }
    })
    return { upstream, downstream, edgeIds, nodes: new Set([...upstream, ...downstream]) }
  }

  for (let pass = 0; pass < edges.length + 1; pass += 1) {
    let changed = false
    edges.forEach(edge => {
      if (edge.kind === 'co_learning' && pass > 0) return
      if (upstream.has(edge.to) && !upstream.has(edge.from)) {
        upstream.add(edge.from)
        changed = true
      }
      if (downstream.has(edge.from) && !downstream.has(edge.to)) {
        downstream.add(edge.to)
        changed = true
      }
      if (
        upstream.has(edge.to) && upstream.has(edge.from)
        || downstream.has(edge.from) && downstream.has(edge.to)
      ) edgeIds.add(edge.id)
    })
    if (!changed) break
  }
  return { upstream, downstream, edgeIds, nodes: new Set([...upstream, ...downstream]) }
}

export function learningStageIndex(stage: PathStage) {
  return stageIndex.get(stage) || 0
}
