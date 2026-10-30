import fs from 'node:fs'
import net from 'node:net'

export type ProbeState = 'live' | 'absent' | 'unknown'

export function probeSocket(socketPath: string, timeoutMs = 1500): Promise<ProbeState> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('unknown')
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve('live')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(error.code === 'ENOENT' ? 'absent' : error.code === 'ECONNREFUSED' ? 'absent' : 'unknown')
    })
  })
}

export function pidAlive(pidFile: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid?: number }
    if (typeof raw.pid !== 'number') return false
    process.kill(raw.pid, 0)
    return true
  } catch {
    return false
  }
}
