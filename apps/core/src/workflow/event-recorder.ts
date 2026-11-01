import type { WorkflowEventRepository } from '../db/repositories/workflow-event-repository'
import type { ControlEventSink } from './control-nodes'
import type { ReworkEvent, ReworkEventSink } from './rework-service'

export type WorkflowEventLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
}

/**
 * 控制节点 / 返工事件 → workflow_events。
 * event_id 由「业务实体 + 事件类型 + 轮次」确定性生成，重复投递只会被 INSERT OR IGNORE 吃掉。
 */
export class WorkflowEventRecorder implements ControlEventSink, ReworkEventSink {
  constructor(
    private readonly events: WorkflowEventRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly logger?: WorkflowEventLogger,
  ) {}

  publish(event: { type: string; runId: string }): void {
    const eventId = `workflow:${event.runId}:${event.type}`
    try {
      this.events.append({
        eventId,
        workflowRunId: event.runId,
        eventType: event.type,
        occurredAt: this.now(),
      })
    } catch (error) {
      this.logger?.warn('workflow event append failed', {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  publishRework(event: ReworkEvent): void {
    const eventId = `rework:${event.reworkRequestId}:${event.type}:${event.round}`
    try {
      this.events.append({
        eventId,
        workflowRunId: event.runId,
        eventType: event.type,
        payload: {
          reworkRequestId: event.reworkRequestId,
          targetNodeKey: event.targetNodeKey,
          round: event.round,
        },
        occurredAt: this.now(),
      })
    } catch (error) {
      this.logger?.warn('rework event append failed', {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
