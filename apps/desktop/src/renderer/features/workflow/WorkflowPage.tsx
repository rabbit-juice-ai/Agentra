import type { WorkflowTemplate, WorkflowVersion } from '@agentra/protocol'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buttonStyle,
  colors,
  dangerButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
  sectionTitleStyle,
} from '../../components/styles'
import { ApiError } from '../../services/api'
import {
  createNode,
  defaultEdgeAttributes,
  definitionToJson,
  edgeLabel,
  fromFlow,
  nextKey,
  parseDefinitionJson,
  toFlowEdges,
  toFlowNodes,
} from './definition'
import { NodeConfigPanel } from './NodeConfigPanel'
import type {
  DefinitionEdge,
  DefinitionNode,
  NodeType,
  Violation,
  WorkflowDefinition,
  WorkflowFlowEdge,
  WorkflowFlowNode,
} from './types'
import { NODE_TYPE_LABELS, NODE_TYPES } from './types'
import { WorkflowCanvas } from './WorkflowCanvas'
import { workflowApi } from './workflow-api'

/** 发布构建检查用的产品页标记：见 scripts/check-release-bundle.mjs 的 REQUIRED_MARKERS。 */
export const WORKFLOW_PAGE_MARKER = 'agentra-product-workflow'

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string }

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function violationsFromError(error: unknown): Violation[] {
  if (!(error instanceof ApiError)) return []
  const detail = error.detail
  if (typeof detail !== 'object' || detail === null) return []
  const violations = (detail as { violations?: unknown }).violations
  return Array.isArray(violations) ? (violations as Violation[]) : []
}

export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  const [nodes, setNodes] = useState<WorkflowFlowNode[]>([])
  const [edges, setEdges] = useState<WorkflowFlowEdge[]>([])
  const [settings, setSettings] = useState<Record<string, unknown> | undefined>(undefined)
  const [selection, setSelection] = useState<Selection | null>(null)

  const [violations, setViolations] = useState<Violation[]>([])
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [newTemplateName, setNewTemplateName] = useState('')
  const [importText, setImportText] = useState('')
  const [exportJson, setExportJson] = useState('')

  const refreshTemplates = useCallback(async (preferId?: string) => {
    const list = await workflowApi.listTemplates(true)
    setTemplates(list)
    if (preferId) setSelectedTemplateId(preferId)
  }, [])

  const refreshVersions = useCallback(async (templateId: string) => {
    const { versions: list, skipped } = await workflowApi.listVersions(templateId)
    setVersions(list)
    if (skipped.length > 0) {
      setBanner(
        `已跳过 ${skipped.length} 条不可读版本：${skipped.map((item) => item.id).join('、')}`,
      )
    }
    return list
  }, [])

  useEffect(() => {
    void refreshTemplates().catch((cause) => setError(errorMessage(cause)))
  }, [refreshTemplates])

  useEffect(() => {
    if (!selectedTemplateId) {
      setVersions([])
      return
    }
    void refreshVersions(selectedTemplateId).catch((cause) => setError(errorMessage(cause)))
  }, [selectedTemplateId, refreshVersions])

  const selectedNode = useMemo(() => {
    if (selection?.kind !== 'node') return null
    return nodes.find((node) => node.id === selection.id)?.data.node ?? null
  }, [nodes, selection])

  const selectedEdge = useMemo(() => {
    if (selection?.kind !== 'edge') return null
    return edges.find((edge) => edge.id === selection.id)?.data?.edge ?? null
  }, [edges, selection])

  const violationByNode = useMemo(() => {
    const map = new Map<string, string>()
    for (const violation of violations) {
      if (!violation.nodeKey) continue
      const existing = map.get(violation.nodeKey)
      map.set(violation.nodeKey, existing ? `${existing}；${violation.message}` : violation.message)
    }
    return map
  }, [violations])

  const violationByEdge = useMemo(() => {
    const set = new Set<string>()
    for (const violation of violations) {
      if (violation.edgeKey) set.add(violation.edgeKey)
    }
    return set
  }, [violations])

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: { ...node.data, violation: violationByNode.get(node.id) },
      })),
    [nodes, violationByNode],
  )

  const displayEdges = useMemo(
    () =>
      edges.map((edge) =>
        violationByEdge.has(edge.id)
          ? { ...edge, style: { stroke: colors.red, strokeWidth: 2 } }
          : edge,
      ),
    [edges, violationByEdge],
  )

  const currentDefinition = useCallback((): WorkflowDefinition => {
    return fromFlow(nodes, edges, settings)
  }, [nodes, edges, settings])

  const onNodesChange = useCallback((changes: NodeChange<WorkflowFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      const source = nodes.find((node) => node.id === connection.source)
      const attributes = defaultEdgeAttributes(
        source?.data.node.type,
        connection.source,
        edges.map((edge) => edge.data?.edge).filter((edge): edge is DefinitionEdge => !!edge),
      )
      const key = nextKey(
        'edge',
        edges.map((edge) => edge.id),
      )
      const definitionEdge: DefinitionEdge = {
        key,
        source: connection.source,
        target: connection.target,
        ...attributes,
      }
      setEdges((current) =>
        addEdge(
          {
            id: key,
            source: connection.source as string,
            target: connection.target as string,
            data: { edge: definitionEdge },
            label: edgeLabel(definitionEdge),
          },
          current,
        ),
      )
    },
    [edges, nodes],
  )

  const updateNodeConfig = useCallback(
    (key: string, config: Record<string, unknown>, label?: string) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== key) return node
          const nextNode: DefinitionNode = { ...node.data.node, config }
          if (label !== undefined) nextNode.label = label
          return { ...node, data: { ...node.data, node: nextNode } }
        }),
      )
    },
    [],
  )

  const updateEdge = useCallback((key: string, patch: Partial<DefinitionEdge>) => {
    setEdges((current) =>
      current.map((edge) => {
        if (edge.id !== key) return edge
        const base = edge.data?.edge ?? { key, source: edge.source, target: edge.target }
        const merged = { ...base, ...patch }
        const next: DefinitionEdge = {
          key: merged.key,
          source: merged.source,
          target: merged.target,
        }
        if (merged.branchKey !== undefined && merged.branchKey !== '') {
          next.branchKey = merged.branchKey
        }
        if (merged.when !== undefined) next.when = merged.when
        return { ...edge, data: { ...edge.data, edge: next }, label: edgeLabel(next) }
      }),
    )
  }, [])

  const validate = useCallback(async (definition: WorkflowDefinition): Promise<boolean> => {
    try {
      const result = await workflowApi.validate(definition)
      if (result.valid) {
        setViolations([])
        return true
      }
      setViolations(result.violations as Violation[])
      setBanner(`校验未通过：${result.violations.length} 处问题，点击列表可定位`)
      return false
    } catch (cause) {
      setViolations(violationsFromError(cause))
      setError(errorMessage(cause))
      return false
    }
  }, [])

  const handleNewCanvas = useCallback(() => {
    const start = createNode('start', { x: 120, y: 80 }, [])
    setNodes(toFlowNodes({ schemaVersion: 1, nodes: [start], edges: [] }))
    setEdges([])
    setSettings(undefined)
    setViolations([])
    setSelection(null)
    setBanner('已新建空画布：从左侧节点面板添加节点')
  }, [])

  const loadVersion = useCallback((version: WorkflowVersion) => {
    const definition = version.definition as WorkflowDefinition
    setNodes(toFlowNodes(definition))
    setEdges(toFlowEdges(definition))
    setSettings(definition.settings)
    setSelectedVersionId(version.id)
    setViolations([])
    setSelection(null)
    setBanner(`已载入 v${version.version}（${version.status}）`)
  }, [])

  const handleAddNode = useCallback((type: NodeType) => {
    setNodes((current) => {
      const existing = current.map((node) => node.data.node)
      const position = {
        x: 420 + (current.length % 3) * 200,
        y: 80 + Math.floor(current.length / 3) * 110,
      }
      const node = createNode(type, position, existing)
      return [...current, ...toFlowNodes({ schemaVersion: 1, nodes: [node], edges: [] })]
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!selectedTemplateId) {
      setError('先选择或新建一个模板，再保存草稿')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const definition = currentDefinition()
      if (!(await validate(definition))) return
      const version = await workflowApi.createDraft(selectedTemplateId, definition)
      await refreshVersions(selectedTemplateId)
      setSelectedVersionId(version.id)
      setBanner(`已保存为 draft v${version.version}（checksum ${version.checksum.slice(0, 12)}…）`)
    } catch (cause) {
      const detailViolations = violationsFromError(cause)
      if (detailViolations.length > 0) setViolations(detailViolations)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [currentDefinition, refreshVersions, selectedTemplateId, validate])

  const handleValidate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await validate(currentDefinition())
    } finally {
      setBusy(false)
    }
  }, [currentDefinition, validate])

  const handlePublish = useCallback(
    async (version: WorkflowVersion) => {
      setBusy(true)
      setError(null)
      try {
        if (!(await validate(version.definition as WorkflowDefinition))) return
        const published = await workflowApi.publish(version.id)
        if (selectedTemplateId) await refreshVersions(selectedTemplateId)
        setBanner(`v${published.version} 已发布（checksum 不可再修改）`)
      } catch (cause) {
        const detailViolations = violationsFromError(cause)
        if (detailViolations.length > 0) setViolations(detailViolations)
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [refreshVersions, selectedTemplateId, validate],
  )

  const handleCreateTemplate = useCallback(async () => {
    const name = newTemplateName.trim()
    if (name === '') return
    setBusy(true)
    setError(null)
    try {
      const template = await workflowApi.createTemplate(name)
      setNewTemplateName('')
      await refreshTemplates(template.id)
      setBanner(`模板「${template.name}」已创建`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [newTemplateName, refreshTemplates])

  const handleArchiveTemplate = useCallback(async () => {
    if (!selectedTemplateId) return
    setBusy(true)
    setError(null)
    try {
      const archived = await workflowApi.archiveTemplate(selectedTemplateId)
      await refreshTemplates(archived.id)
      setBanner('模板已归档；已发布版本与 checksum 保留，可继续查看')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [refreshTemplates, selectedTemplateId])

  const handleImport = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const parsed = parseDefinitionJson(importText)
      if (!parsed.ok) {
        setError(`导入被拒绝：${parsed.message}`)
        return
      }
      // 未知字段由服务端严格 Schema 拒绝（validate 使用同一定义 Schema）。
      if (!(await validate(parsed.definition))) {
        setError('导入被拒绝：定义未通过校验（详见右侧 violations）')
        return
      }
      setNodes(toFlowNodes(parsed.definition))
      setEdges(toFlowEdges(parsed.definition))
      setSettings(parsed.definition.settings)
      setSelection(null)
      setBanner('导入成功；保存前仍会再次校验')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [importText, validate])

  const handleExport = useCallback(() => {
    setExportJson(definitionToJson(currentDefinition()))
  }, [currentDefinition])

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null

  return (
    <div data-agentra-page={WORKFLOW_PAGE_MARKER} style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Workflow 定义</h2>
        <span style={{ fontSize: 12, color: colors.muted }}>
          阶段 3 只做定义、校验、保存、发布；不创建任何执行
        </span>
      </div>

      {banner && (
        <div
          data-testid="workflow-banner"
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: `1px solid ${colors.green}`,
            background: '#dafbe1',
            fontSize: 12,
          }}
        >
          {banner}
        </div>
      )}
      {error && (
        <div
          data-testid="workflow-error"
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: `1px solid ${colors.red}`,
            background: '#ffebe9',
            fontSize: 12,
            color: colors.red,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{ display: 'grid', gridTemplateColumns: '260px minmax(480px, 1fr) 300px', gap: 12 }}
      >
        <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <section style={panelStyle}>
            <h3 style={sectionTitleStyle}>模板</h3>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                data-testid="workflow-template-name"
                style={inputStyle}
                placeholder="新模板名称"
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
              />
              <button
                type="button"
                data-testid="workflow-template-create"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => void handleCreateTemplate()}
              >
                新建
              </button>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {templates.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    data-testid={`workflow-template-${template.name}`}
                    style={{
                      ...buttonStyle,
                      width: '100%',
                      textAlign: 'left',
                      borderColor: template.id === selectedTemplateId ? colors.blue : colors.border,
                    }}
                    onClick={() => setSelectedTemplateId(template.id)}
                  >
                    {template.name}
                    {template.archivedAt ? '（已归档）' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section style={panelStyle}>
            <h3 style={sectionTitleStyle}>版本</h3>
            {selectedTemplate ? (
              <>
                <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
                  带已发布版本的模板只能归档、不能删除；归档后版本与 checksum 保留。
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                  {versions.map((version) => (
                    <li key={version.id} style={{ display: 'grid', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          type="button"
                          data-testid={`workflow-version-${version.version}`}
                          style={{ ...buttonStyle, flex: 1, textAlign: 'left' }}
                          onClick={() => loadVersion(version)}
                        >
                          v{version.version} · {version.status}
                          {selectedVersionId === version.id ? ' · 当前' : ''}
                        </button>
                        {version.status === 'draft' && (
                          <button
                            type="button"
                            data-testid={`workflow-publish-${version.version}`}
                            style={primaryButtonStyle}
                            disabled={busy}
                            onClick={() => void handlePublish(version)}
                          >
                            发布
                          </button>
                        )}
                      </div>
                      <span style={{ fontSize: 10, color: colors.muted }}>
                        {version.checksum.slice(0, 16)}…
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  data-testid="workflow-archive-template"
                  style={{ ...dangerButtonStyle, marginTop: 8 }}
                  disabled={busy || selectedTemplate.archivedAt !== null}
                  onClick={() => void handleArchiveTemplate()}
                >
                  归档模板
                </button>
              </>
            ) : (
              <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>先选择模板</p>
            )}
          </section>

          <section style={panelStyle}>
            <h3 style={sectionTitleStyle}>导入 / 导出</h3>
            <textarea
              data-testid="workflow-import-text"
              style={{ ...inputStyle, minHeight: 70, fontFamily: 'ui-monospace, monospace' }}
              placeholder="粘贴 definition JSON 后点击导入"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                data-testid="workflow-import"
                style={buttonStyle}
                disabled={busy}
                onClick={() => void handleImport()}
              >
                导入
              </button>
              <button
                type="button"
                data-testid="workflow-export"
                style={buttonStyle}
                onClick={handleExport}
              >
                导出
              </button>
            </div>
            <textarea
              data-testid="workflow-export-json"
              readOnly
              style={{
                ...inputStyle,
                minHeight: 90,
                marginTop: 6,
                fontFamily: 'ui-monospace, monospace',
              }}
              value={exportJson}
            />
          </section>
        </aside>

        <section style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {NODE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                data-testid={`workflow-palette-${type}`}
                style={buttonStyle}
                onClick={() => handleAddNode(type)}
              >
                + {NODE_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-testid="workflow-new-canvas"
              style={buttonStyle}
              onClick={handleNewCanvas}
            >
              新建画布
            </button>
            <button
              type="button"
              data-testid="workflow-validate"
              style={buttonStyle}
              disabled={busy}
              onClick={() => void handleValidate()}
            >
              校验
            </button>
            <button
              type="button"
              data-testid="workflow-save"
              style={primaryButtonStyle}
              disabled={busy || !selectedTemplateId}
              onClick={() => void handleSave()}
            >
              保存为草稿
            </button>
          </div>
          <WorkflowCanvas
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(node) => setSelection({ kind: 'node', id: node.id })}
            onEdgeClick={(edge) => setSelection({ kind: 'edge', id: edge.id })}
            onPaneClick={() => setSelection(null)}
          />
        </section>

        <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <NodeConfigPanel
            node={selectedNode}
            edge={selectedEdge}
            nodes={nodes.map((node) => node.data.node)}
            onChangeNode={updateNodeConfig}
            onChangeEdge={updateEdge}
          />
          <section style={panelStyle} data-testid="workflow-violations">
            <h3 style={sectionTitleStyle}>校验结果（{violations.length}）</h3>
            {violations.length === 0 ? (
              <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>暂无问题</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {violations.map((violation, index) => (
                  <li
                    key={`${violation.violation}-${violation.nodeKey ?? ''}-${violation.edgeKey ?? ''}-${violation.message}`}
                  >
                    <button
                      type="button"
                      data-testid={`workflow-violation-${index}`}
                      style={{
                        ...buttonStyle,
                        width: '100%',
                        textAlign: 'left',
                        borderColor: colors.red,
                      }}
                      onClick={() => {
                        if (violation.nodeKey) {
                          setSelection({ kind: 'node', id: violation.nodeKey })
                        } else if (violation.edgeKey) {
                          setSelection({ kind: 'edge', id: violation.edgeKey })
                        }
                      }}
                    >
                      <strong style={{ color: colors.red }}>{violation.violation}</strong>
                      <span style={{ color: colors.muted }}>
                        {violation.nodeKey ? ` · 节点 ${violation.nodeKey}` : ''}
                        {violation.edgeKey ? ` · 边 ${violation.edgeKey}` : ''}
                      </span>
                      <div style={{ fontSize: 11, color: colors.text }}>{violation.message}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
