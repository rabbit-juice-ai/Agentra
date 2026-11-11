#!/usr/bin/env node
// Deterministic CLI fixture for node recovery E2E. Always returns one explicit artifact.
import readline from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('9.9.9 (node-recovery-fixture)')
  process.exit(0)
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' }))
  process.exit(0)
}

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type !== 'user') return
  const result = JSON.stringify({
    agentraOutputVersion: 1,
    output: { recovered: true },
    artifacts: [{ name: 'spec', content: 'node-recovery-artifact-proof' }],
  })
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: result }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, result })
})
lines.on('close', () => process.exit(0))
