import type { Project, ProjectCreateParams, ProjectStatus, Work } from '@agentra/protocol'
import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PageHeader } from './PageHeader'

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
}

const PROJECT_STATUS_TONE: Record<ProjectStatus, string> = {
  active: 'done',
  paused: 'warn',
  completed: 'done',
  archived: 'pending',
}

export function ProjectsPage({
  projects,
  works,
  busy,
  onCreateProject,
  onUpdateProject,
  onOpenProjectTasks,
}: {
  projects: Project[]
  works: Work[]
  busy: boolean
  onCreateProject: (params: ProjectCreateParams) => Promise<boolean>
  onUpdateProject: (params: {
    id: string
    name?: string
    description?: string
    status?: ProjectStatus
  }) => Promise<boolean>
  onOpenProjectTasks: (projectId: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const work of works) {
      if (work.projectId) counts.set(work.projectId, (counts.get(work.projectId) ?? 0) + 1)
    }
    return counts
  }, [works])

  const submit = async (): Promise<void> => {
    if (name.trim() === '' || busy) return
    const ok = await onCreateProject({
      name: name.trim(),
      description: description.trim() || undefined,
    })
    if (ok) {
      setName('')
      setDescription('')
      setCreating(false)
    }
  }

  return (
    <div data-agentra-page="agentra-product-projects" className="page">
      <PageHeader
        title="项目"
        subtitle={`${projects.length} 个项目 · ${works.length} 个任务 · 项目是任务的合集`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            新建项目
          </button>
        }
      />

      <Modal
        open={creating}
        title="新建项目"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || name.trim() === ''}
              onClick={() => void submit()}
            >
              创建项目
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：Agentra MVP"
            />
          </div>
          <div className="field">
            <label htmlFor="project-description">描述</label>
            <textarea
              id="project-description"
              className="textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个项目要解决什么问题？"
            />
          </div>
        </div>
      </Modal>

      {projects.length === 0 ? (
        <div className="empty-state">还没有项目。新建一个项目，再把任务放进去。</div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 12,
          }}
        >
          {projects.map((project) => (
            <div className="card" key={project.id}>
              <div className="card-head">
                <div className="card-title">
                  {project.name}
                  <span className={`pill ${PROJECT_STATUS_TONE[project.status]}`}>
                    {PROJECT_STATUS_LABEL[project.status]}
                  </span>
                </div>
                <div className="right">
                  <select
                    className="select"
                    value={project.status}
                    disabled={busy}
                    onChange={(event) =>
                      void onUpdateProject({
                        id: project.id,
                        status: event.target.value as ProjectStatus,
                      })
                    }
                    aria-label={`${project.name} 状态`}
                  >
                    {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {PROJECT_STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {project.description || '暂无描述'}
                </div>
                <div className="faint" style={{ fontSize: 11 }}>
                  {taskCounts.get(project.id) ?? 0} 个任务 · 创建于{' '}
                  {new Date(project.createdAt).toLocaleDateString()}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ justifySelf: 'start' }}
                  onClick={() => onOpenProjectTasks(project.id)}
                >
                  查看任务
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
