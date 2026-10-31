import { NODE_TYPES, type NodeType } from '@agentra/workflow-schema'
import { describe, expect, it } from 'vitest'
import {
  type NodeHandlerContext,
  NodeHandlerRegistry,
  UnknownNodeHandlerError,
} from './node-handler-registry'

function context(type: NodeType): NodeHandlerContext {
  return {
    runId: 'run-1',
    branchRunId: null,
    nodeRunId: `node-${type}`,
    nodeKey: `key_${type}`,
    attempt: 1,
    definition: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    node: { key: `key_${type}`, type, position: { x: 0, y: 0 }, config: {} },
  } as unknown as NodeHandlerContext
}

describe('NodeHandlerRegistry', () => {
  it('dispatches every MVP node type without a switch in the engine', async () => {
    const registry = new NodeHandlerRegistry()
    for (const type of NODE_TYPES) {
      registry.register(type, (ctx) => ({ status: 'succeeded', patch: { handled: ctx.nodeKey } }))
    }
    registry.assertComplete()

    for (const type of NODE_TYPES) {
      const outcome = await registry.dispatch(type, context(type))
      expect(outcome.status).toBe('succeeded')
      expect(outcome.patch).toEqual({ handled: `key_${type}` })
    }
  })

  it('reports missing handlers at startup instead of failing silently', () => {
    const registry = new NodeHandlerRegistry()
    registry.register('start', () => ({ status: 'succeeded' }))

    expect(() => registry.assertComplete()).toThrow(/missing node handlers/)
    try {
      registry.assertComplete()
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('end')
      expect(message).toContain('condition')
    }
  })

  it('throws a typed error for an unregistered type', async () => {
    const registry = new NodeHandlerRegistry()
    await expect(registry.dispatch('agent_task', context('agent_task'))).rejects.toBeInstanceOf(
      UnknownNodeHandlerError,
    )
  })

  it('awaits async handlers', async () => {
    const registry = new NodeHandlerRegistry()
    registry.register('condition', async () => {
      await Promise.resolve()
      return { status: 'succeeded' }
    })
    await expect(registry.dispatch('condition', context('condition'))).resolves.toEqual({
      status: 'succeeded',
    })
  })
})
