import { describe, expect, it } from 'vitest'
import {
  assertBranchTransition,
  assertNodeTransition,
  assertReworkTransition,
  assertRunTransition,
  branchTargets,
  IllegalWorkflowTransitionError,
  isTerminalBranchStatus,
  isTerminalNodeStatus,
  isTerminalReworkStatus,
  isTerminalRunStatus,
  nodeTargets,
  type ReworkRequestStatus,
  runTargets,
} from './state-machine'

describe('WorkflowRun 状态机', () => {
  it('allows the documented lifecycle and blocks terminal resurrections', () => {
    expect(() => assertRunTransition('pending', 'running')).not.toThrow()
    expect(() => assertRunTransition('running', 'paused')).not.toThrow()
    expect(() => assertRunTransition('paused', 'running')).not.toThrow()
    expect(() => assertRunTransition('running', 'waiting_human')).not.toThrow()
    expect(() => assertRunTransition('waiting_human', 'running')).not.toThrow()
    expect(() => assertRunTransition('running', 'reconciliation_required')).not.toThrow()
    expect(() => assertRunTransition('reconciliation_required', 'running')).not.toThrow()

    expect(() => assertRunTransition('pending', 'completed')).toThrow(
      IllegalWorkflowTransitionError,
    )
    expect(() => assertRunTransition('completed', 'running')).toThrow()
    expect(() => assertRunTransition('failed', 'cancelled')).toThrow()
  })

  it('marks completed / failed / cancelled as terminal', () => {
    expect(isTerminalRunStatus('completed')).toBe(true)
    expect(isTerminalRunStatus('failed')).toBe(true)
    expect(isTerminalRunStatus('cancelled')).toBe(true)
    expect(isTerminalRunStatus('reconciliation_required')).toBe(false)
    expect(runTargets('completed')).toEqual([])
  })
})

describe('BranchRun 状态机', () => {
  it('allows blocked → active → paused → active and terminal ends', () => {
    expect(() => assertBranchTransition('blocked', 'active')).not.toThrow()
    expect(() => assertBranchTransition('active', 'paused')).not.toThrow()
    expect(() => assertBranchTransition('paused', 'active')).not.toThrow()
    expect(() => assertBranchTransition('active', 'completed')).not.toThrow()
    expect(() => assertBranchTransition('paused', 'cancelled')).not.toThrow()

    expect(() => assertBranchTransition('completed', 'active')).toThrow()
    expect(isTerminalBranchStatus('completed')).toBe(true)
    expect(branchTargets('cancelled')).toEqual([])
  })
})

describe('NodeRun 状态机', () => {
  it('covers the MVP node status subset and its transitions', () => {
    expect(() => assertNodeTransition('blocked', 'ready')).not.toThrow()
    expect(() => assertNodeTransition('ready', 'running')).not.toThrow()
    expect(() => assertNodeTransition('running', 'succeeded')).not.toThrow()
    expect(() => assertNodeTransition('running', 'failed')).not.toThrow()
    expect(() => assertNodeTransition('waiting_approval', 'succeeded')).not.toThrow()
    expect(() => assertNodeTransition('waiting_approval', 'changes_requested')).not.toThrow()
    expect(() => assertNodeTransition('changes_requested', 'ready')).not.toThrow()
    expect(() => assertNodeTransition('rejected', 'ready')).not.toThrow()
    expect(() => assertNodeTransition('reconciliation_required', 'ready')).not.toThrow()

    expect(() => assertNodeTransition('succeeded', 'running')).toThrow()
    expect(() => assertNodeTransition('failed', 'ready')).toThrow()
    expect(() => assertNodeTransition('blocked', 'succeeded')).toThrow()
  })

  it('treats succeeded / failed / cancelled / skipped as terminal', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'skipped'] as const) {
      expect(isTerminalNodeStatus(status)).toBe(true)
      expect(nodeTargets(status)).toEqual([])
    }
    expect(isTerminalNodeStatus('waiting_approval')).toBe(false)
    expect(isTerminalNodeStatus('changes_requested')).toBe(false)
  })
})

describe('ReworkRequest 状态机', () => {
  it('allows requested → in_rework → completed / cancelled / exhausted', () => {
    expect(() => assertReworkTransition('requested', 'in_rework')).not.toThrow()
    for (const terminal of ['completed', 'cancelled', 'exhausted'] as const) {
      expect(() => assertReworkTransition('in_rework', terminal)).not.toThrow()
      expect(isTerminalReworkStatus(terminal)).toBe(true)
    }
    expect(() => assertReworkTransition('requested', 'exhausted')).not.toThrow()
    expect(() => assertReworkTransition('requested', 'cancelled')).not.toThrow()
  })

  it('blocks transitions out of terminal states', () => {
    for (const terminal of ['completed', 'cancelled', 'exhausted'] as ReworkRequestStatus[]) {
      for (const target of ['requested', 'in_rework', 'completed'] as ReworkRequestStatus[]) {
        expect(() => assertReworkTransition(terminal, target)).toThrow(
          IllegalWorkflowTransitionError,
        )
      }
    }
  })
})
