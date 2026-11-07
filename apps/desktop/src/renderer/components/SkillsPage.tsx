import type { Skill, SkillCreateParams, SkillUpdateParams } from '@agentra/protocol'
import { type FormEvent, useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'

type Props = {
  skills: Skill[]
  busy: boolean
  onCreate: (params: SkillCreateParams) => Promise<boolean>
  onUpdate: (params: SkillUpdateParams) => Promise<boolean>
  onDelete: (id: string) => Promise<void>
}

/**
 * 全局技能库：技能内容在这里维护，Agent 只引用。
 * 删除会同步从所有 Agent 的引用中移除（Core 事务保证）。
 */
export function SkillsPage({ skills, busy, onCreate, onUpdate, onDelete }: Props) {
  const [formMode, setFormMode] = useState<'none' | 'create' | 'edit'>('none')
  const [editing, setEditing] = useState<Skill | null>(null)
  const [deleting, setDeleting] = useState<Skill | null>(null)

  const closeForm = (): void => {
    setEditing(null)
    setFormMode('none')
  }

  return (
    <div className="page">
      <PageHeader
        title="技能"
        subtitle={<>{skills.length} 项技能 · Agent 从技能库中选择，执行时追加到工作指令</>}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              setEditing(null)
              setFormMode('create')
            }}
          >
            <Icon name="plus" size={14} />
            新建技能
          </button>
        }
      />

      <div className="card">
        {skills.length === 0 ? (
          <div className="empty-state">
            技能库还是空的。创建一个技能（例如「代码评审清单」），之后可在 Agent 配置中选择。
          </div>
        ) : (
          <table className="agents-table">
            <thead>
              <tr>
                <th>技能</th>
                <th>说明</th>
                <th>指令预览</th>
                <th>更新时间</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id}>
                  <td>
                    <div className="name">{skill.name}</div>
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {skill.description || '—'}
                    </span>
                  </td>
                  <td style={{ maxWidth: 360 }}>
                    <span className="faint" style={{ fontSize: 11.5 }}>
                      {skill.instructions.length > 120
                        ? `${skill.instructions.slice(0, 120)}…`
                        : skill.instructions}
                    </span>
                  </td>
                  <td>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {new Date(skill.updatedAt).toLocaleString()}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => {
                          setEditing(skill)
                          setFormMode('edit')
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm danger"
                        disabled={busy}
                        onClick={() => setDeleting(skill)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {formMode !== 'none' && (
        <SkillForm
          initial={formMode === 'edit' ? editing : null}
          busy={busy}
          onSubmit={(params) =>
            formMode === 'edit'
              ? onUpdate(params as SkillUpdateParams)
              : onCreate(params as SkillCreateParams)
          }
          onCancel={closeForm}
        />
      )}

      <Modal
        open={deleting !== null}
        title={deleting ? `删除技能 · ${deleting.name}` : '删除技能'}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (!deleting) return
                const target = deleting
                setDeleting(null)
                void onDelete(target.id)
              }}
            >
              删除
            </button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7 }}>
          删除后，所有 Agent 对该技能的引用会同步移除；已发生的历史执行记录不受影响。
        </p>
      </Modal>
    </div>
  )
}

function SkillForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: Skill | null
  busy: boolean
  onSubmit: (params: SkillCreateParams | SkillUpdateParams) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')

  useEffect(() => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setInstructions(initial?.instructions ?? '')
  }, [initial])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const base = {
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
    }
    const ok = await onSubmit(initial ? { ...base, id: initial.id } : base)
    if (ok) onCancel()
  }

  return (
    <Modal
      open
      title={initial ? `编辑技能 · ${initial.name}` : '新建技能'}
      onClose={onCancel}
      width={620}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            form="skill-form"
            className="btn btn-primary"
            disabled={busy || name.trim() === '' || instructions.trim() === ''}
          >
            {initial ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <form id="skill-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="skill-name">名称 *</label>
          <input
            id="skill-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：代码评审清单"
            required
          />
          <span className="field-hint">在 Agent 配置里用它来选择这个技能；名称不能重复。</span>
        </div>
        <div className="field">
          <label htmlFor="skill-description">说明</label>
          <input
            id="skill-description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="一句话说明这个技能解决什么问题"
          />
        </div>
        <div className="field">
          <label htmlFor="skill-instructions">技能指令 *</label>
          <textarea
            id="skill-instructions"
            className="textarea"
            rows={8}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="把可复用的工作方法写清楚，例如：评审时先检查错误路径，再检查测试覆盖……"
            required
          />
          <span className="field-hint">
            这段内容会在执行时追加到 Agent 的工作指令之后；写具体步骤，避免泛泛而谈。
          </span>
        </div>
      </form>
    </Modal>
  )
}
