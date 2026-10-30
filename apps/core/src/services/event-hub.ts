import type { RuntimeEvent } from '@agentra/protocol'

/** Core → Desktop 的事件总线（events.subscribe 的订阅者）。 */
export class CoreEventHub {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个 Desktop 连接异常不得影响事件分发。
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}
