#!/usr/bin/env node
// Deterministic Codex CLI fixture for provider lifecycle tests.
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('0.166.0')
  process.exit(0)
}
if (args[0] === 'exec') {
  const prompt = args[args.length - 1] ?? ''
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }))
  console.log(JSON.stringify({ type: 'turn.started' }))
  if (prompt.includes('FAIL')) {
    console.log(JSON.stringify({ type: 'turn.failed', message: 'fixture failure' }))
    process.exit(1)
  }
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: 'OK' },
    }),
  )
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
  process.exit(0)
}
process.exit(1)
