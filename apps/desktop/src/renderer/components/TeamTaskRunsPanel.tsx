import type { AgentProfile, TeamTaskGetResult, TeamTaskRun } from '@agentra/protocol'
import { useEffect, useState } from 'react'
import { api } from '../services/api'
import { toolLabel } from '../utils/tool-label'

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function runTone(status: TeamTaskRun['status']): string {
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'cancelled') return 'blocked'
  return 'idle'
}

export function TeamTaskRunsPanel({ workId, agents }: { workId: string; agents: AgentProfile[] }) {
  const [view, setView] = useState<TeamTaskGetResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api
        .getTeamTask({ workId })
        .then((loaded) => {
          if (!cancelled) {
            setView(loaded)
            setError(null)
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const timer = setInterval(load, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [workId])

  if (!view) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="empty-state">{error ?? '加载执行记录…'}</div>
        </div>
      </div>
    )
  }

  const steps = view.steps ?? []
  const runs = [...view.runs]
    .reverse()
    .map((run) => ({ run, steps: steps.filter((step) => step.runId === run.id) }))
    .filter((item) => item.steps.length > 0)

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          执行记录
          <span className="faint">{runs.length} 次运行</span>
        </div>
      </div>
      <div className="card-body">
        {error && <div className="banner error">{error}</div>}
        {runs.length === 0 ? (
          <div className="empty-state">
            还没有执行记录。成员运行后，Bash / Read / Edit 等步骤会显示在这里。
          </div>
        ) : (
          <div className="team-run-records">
            {runs.map(({ run, steps: runSteps }) => {
              const agent = agents.find((item) => item.id === run.agentId)
              return (
                <details className="team-run-record" key={run.id} open={run.status === 'running'}>
                  <summary>
                    <span className={`team-member-dot ${runTone(run.status)}`} />
                    <strong>{agent?.name ?? run.agentId ?? 'Agent'}</strong>
                    <span className="faint">
                      {run.role === 'leader' ? '队长' : '成员'} ·{' '}
                      {RUN_STATUS_LABEL[run.status] ?? run.status}
                    </span>
                    <span className="team-run-record-count">{runSteps.length}</span>
                  </summary>
                  <div className="team-run-steps-list">
                    {runSteps.map((step) => (
                      <div className="team-live-step" key={step.id}>
                        <span className="team-step-name">{toolLabel(step.name)}</span>
                        <span className="team-step-summary" title={step.summary}>
                          {step.summary}
                        </span>
                        <span className="team-message-time">
                          {new Date(step.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
