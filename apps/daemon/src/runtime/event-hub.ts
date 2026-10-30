import type { RuntimeEvent } from '@agentra/protocol'

/** Daemon 内部的执行事件总线：订阅者（Core 的长连接）接收协议层事件。 */
export class RuntimeEventHub {
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
        // 单个订阅者异常不得影响执行与其他订阅者。
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}
