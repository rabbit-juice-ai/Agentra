import { describe, expect, it } from 'vitest'
import { createShutdownHandler, type ShutdownDeps, shutdownWithDrain } from './index'
import { DrainCoordinator } from './lifecycle/drain-coordinator'
import { MaintenanceController } from './lifecycle/maintenance-controller'

const SIGNAL = 'SIGTERM'

type Trace = string[]

function harness(trace: Trace) {
  const maintenance = new MaintenanceController()
  const drain = new DrainCoordinator()
  const calls = {
    closeRuntime: 0,
    closeServer: 0,
    closeDb: 0,
    removePidFile: 0,
    exit: 0,
  }
  const logs: { level: string; message: string; data?: Record<string, unknown> }[] = []
  const deps: ShutdownDeps = {
    signal: SIGNAL,
    maintenance,
    drain,
    closeRuntime: () => {
      calls.closeRuntime += 1
      trace.push('closeRuntime')
    },
    closeServer: () => {
      calls.closeServer += 1
      trace.push('closeServer')
    },
    closeDb: () => {
      calls.closeDb += 1
      trace.push('closeDb')
    },
    removePidFile: () => {
      calls.removePidFile += 1
      trace.push('removePidFile')
    },
    exit: (code) => {
      calls.exit += 1
      trace.push(`exit:${code}`)
    },
    logger: {
      info: (message, data) => logs.push({ level: 'info', message, data }),
      warn: (message, data) => logs.push({ level: 'warn', message, data }),
      error: (message, data) => logs.push({ level: 'error', message, data }),
    },
  }
  return { maintenance, drain, calls, logs, deps }
}

function logOf(logs: ReturnType<typeof harness>['logs'], message: string) {
  return logs.find((entry) => entry.message === message)
}

describe('shutdownWithDrain (S55-2B-1A P1-1)', () => {
  it('waits for an in-flight write lease and closes resources only after it settles', async () => {
    const trace: Trace = []
    const h = harness(trace)
    // 真实 DrainCoordinator + 真实在途写 lease：shutdown 启动 5ms 后释放。
    const lease = h.drain.acquire('rpc-mutation', 'rpc:backup.create')

    const running = shutdownWithDrain({ ...h.deps, drainDeadlineMs: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    // deadline 未到、lease 未释放：DB / Runtime / Server 不得提前关闭。
    expect(trace).toEqual([])
    expect(h.maintenance.state).toBe('shutting_down')
    expect(lease.isReleased).toBe(false)

    lease.release()
    await running

    // 释放之后才按顺序执行资源关闭与退出。
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
    expect(h.calls.exit).toBe(1)
    expect(logOf(h.logs, 'shutdown drain completed')).toBeDefined()
  })

  it('does not close the DB before the deadline while a write lease is in flight', async () => {
    const trace: Trace = []
    const h = harness(trace)
    // 该 lease 从不释放：shutdown 只能走超时路径继续退出。
    h.drain.acquire('backup-write', 'backup:copy')

    const running = shutdownWithDrain({ ...h.deps, drainDeadlineMs: 60 })
    // deadline 内的多个宏任务点上，DB / Runtime / Server 均不得提前关闭：
    // 证明 shutdown 是真实等待在途 lease，而不是 await 一次就往下走。
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(trace).toEqual([])
    }

    await running
    // 超时后按既定策略完成全部清理（诊断日志在超时专项用例中断言）。
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
  })

  it('times out when a lease never releases: logs diagnostics and still exits by policy', async () => {
    const trace: Trace = []
    const h = harness(trace)
    h.drain.acquire('artifact-write', 'artifact:stuck')

    const started = Date.now()
    await shutdownWithDrain({ ...h.deps, drainDeadlineMs: 20 })
    const elapsed = Date.now() - started

    // 等满了 deadline 才继续，而不是立刻退出（证明真的在等）。
    expect(elapsed).toBeGreaterThanOrEqual(15)
    // 资源关闭体仍执行了一次（按既定策略继续退出，不伪装成功、不无限等待）。
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
    // 超时日志包含剩余 lease 的诊断快照。
    const timeoutLog = logOf(
      h.logs,
      'shutdown drain timed out; in-flight operations may be interrupted',
    )
    expect(timeoutLog).toBeDefined()
    expect(timeoutLog?.data).toMatchObject({ timedOut: true, deadlineMs: 20 })
    const snapshot = (timeoutLog?.data?.snapshot ?? {}) as {
      total: number
      counts: Record<string, number>
    }
    expect(snapshot.total).toBe(1)
    expect(snapshot.counts['artifact-write']).toBe(1)
    // 没有伪装成成功排空。
    expect(logOf(h.logs, 'shutdown drain completed')).toBeUndefined()
  })

  it('continues cleanup with an explicit error log when drain rejects', async () => {
    const trace: Trace = []
    const h = harness(trace)
    // drain 被外部破坏（模拟未知内部错误）：Promise 拒绝，不得静默假装成功。
    h.deps.drain.drain = () => Promise.reject(new Error('drain exploded'))

    await shutdownWithDrain({ ...h.deps, drainDeadlineMs: 1_000 })

    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
    const failedLog = logOf(h.logs, 'shutdown drain failed')
    expect(failedLog).toBeDefined()
    expect(failedLog?.data).toMatchObject({ signal: SIGNAL, error: 'drain exploded' })
    expect(logOf(h.logs, 'shutdown drain completed')).toBeUndefined()
    expect(
      logOf(h.logs, 'shutdown drain timed out; in-flight operations may be interrupted'),
    ).toBeUndefined()
  })

  it('still closes the DB once when db.close() itself throws', async () => {
    const trace: Trace = []
    const h = harness(trace)
    let dbCloseCalls = 0
    const deps: ShutdownDeps = {
      ...h.deps,
      closeDb: () => {
        dbCloseCalls += 1
        throw new Error('db already closed')
      },
    }

    await shutdownWithDrain({ ...deps, drainDeadlineMs: 50 })

    expect(dbCloseCalls).toBe(1)
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'removePidFile', 'exit:0'])
    expect(logOf(h.logs, 'database close failed')).toBeDefined()
  })

  it('logs and skips re-entry when shutdown is triggered repeatedly', async () => {
    const trace: Trace = []
    const h = harness(trace)
    const lease = h.drain.acquire('rpc-mutation', 'rpc:workflow.publish')

    const handler = createShutdownHandler(
      (signal) => shutdownWithDrain({ ...h.deps, signal, drainDeadlineMs: 2_000 }),
      h.deps.logger,
    )
    handler(SIGNAL)
    handler(SIGNAL)
    handler('SIGINT')

    // 第一次进入 shutting_down；重复信号只记录日志，不重复 beginShuttingDown/drain。
    expect(h.maintenance.snapshot().lastBlockedOperation).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const repeatedWarns = h.logs.filter(
      (entry) => entry.message === 'shutdown already in progress; ignoring repeated signal',
    )
    expect(repeatedWarns).toHaveLength(2)
    expect(repeatedWarns[1]?.data).toMatchObject({ signal: 'SIGINT' })

    lease.release()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 资源关闭体只执行一次。
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
    expect(h.calls.exit).toBe(1)
    expect(h.calls.closeDb).toBe(1)
  })

  it('blocks new write leases while shutdown drain is waiting', async () => {
    const trace: Trace = []
    const h = harness(trace)
    // 直接使用真实实例：ShutdownDeps.drain 类型只暴露 close/drain。
    const lease = h.drain.acquire('rpc-mutation', 'rpc:agent.create')

    const running = shutdownWithDrain({ ...h.deps, drainDeadlineMs: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 1))

    // shutting_down + drain 关闭后：新 lease 必须被拒绝，在途 lease 仍可完成。
    expect(() => h.drain.acquire('backup-write', 'rpc:backup.create')).toThrow()
    expect(() => h.drain.acquire('worktree-write', 'rpc:worktree.create')).toThrow()
    lease.release()

    await running
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
  })

  it('keeps the original shutdown observable behavior: normal-state drain completes immediately', async () => {
    const trace: Trace = []
    const h = harness(trace)

    // 无在途 lease：排空瞬间完成，顺序与旧实现一致。
    const started = Date.now()
    await shutdownWithDrain({ ...h.deps, drainDeadlineMs: 2_000 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(trace).toEqual(['closeRuntime', 'closeServer', 'closeDb', 'removePidFile', 'exit:0'])
    expect(h.calls.exit).toBe(1)
    expect(h.maintenance.state).toBe('shutting_down')
  })
})
