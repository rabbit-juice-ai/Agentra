import type { AgentGenerateDraftResult } from '@agentra/protocol'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../services/api'
import { Icon } from './Icon'
import { Modal } from './Modal'

const EXAMPLES = ['项目经理', '前端工程师', '测试工程师', 'UI 设计师', '数据分析师']

/**
 * AI 创建入口：只收集一句话需求，生成后把草案交给 AgentForm，
 * 用户仍需选择 Provider 并确认/调整内容后才真正创建。
 */
export function AgentAiCreateModal({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean
  onClose: () => void
  onGenerated: (result: AgentGenerateDraftResult) => void
}) {
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    // 打开/关闭都让旧的生成请求失效，避免关闭后突然弹出表单。
    requestRef.current += 1
    if (!open) return
    setBrief('')
    setBusy(false)
    setError(null)
  }, [open])

  const close = (): void => {
    requestRef.current += 1
    onClose()
  }

  const generate = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = brief.trim()
    if (text === '' || busy) return
    const requestId = ++requestRef.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.generateAgentDraft(text)
      if (requestId !== requestRef.current) return
      onGenerated(result)
    } catch (err) {
      if (requestId !== requestRef.current) return
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="AI 创建 Agent"
      onClose={close}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            form="agent-ai-form"
            className="btn btn-primary"
            disabled={busy || brief.trim() === ''}
          >
            {busy ? '生成中…' : 'AI 生成草案'}
          </button>
        </>
      }
    >
      <form id="agent-ai-form" className="form-grid" onSubmit={(event) => void generate(event)}>
        <div className="field">
          <label htmlFor="agent-ai-brief">你想要什么角色？*</label>
          <textarea
            id="agent-ai-brief"
            className="textarea"
            rows={3}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="例如：项目经理，负责拆解需求、排期和验收标准。"
            disabled={busy}
          />
          <span className="field-hint">
            AI 会生成名称、头像、擅长的工作与调用时机、工作指令、工作权限和技能选择； Provider
            与模型由你在下一步选择。
          </span>
        </div>
        <div className="field">
          <span className="field-label">快速示例</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {EXAMPLES.map((example) => (
              <button
                type="button"
                key={example}
                className="chip"
                onClick={() => setBrief(example)}
                disabled={busy}
                style={{ cursor: 'pointer' }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
        {busy && (
          <div className="banner" style={{ margin: 0 }}>
            正在让 Agent 设计师生成草案，可能需要 30–90 秒。生成后你会进入创建表单，可继续调整。
          </div>
        )}
        {error && (
          <div className="banner error" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <div className="faint" style={{ fontSize: 10.5, display: 'flex', gap: 6 }}>
          <Icon name="zap" size={12} />
          生成失败时会给出基础草案并标注来源，不会假装 AI 成功。
        </div>
      </form>
    </Modal>
  )
}
