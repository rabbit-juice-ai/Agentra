#!/usr/bin/env node
// Deterministic Gemini CLI fixture for provider lifecycle tests.
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('0.52.0')
  process.exit(0)
}
const promptIndex = args.indexOf('-p')
if (promptIndex >= 0) {
  const prompt = args[promptIndex + 1] ?? ''
  if (prompt.includes('FAIL')) {
    console.log(JSON.stringify({ type: 'result', status: 'error', error: { message: 'fixture failure' } }))
    process.exit(1)
  }
  console.log(
    JSON.stringify({ type: 'message', role: 'assistant', content: 'OK', delta: true }),
  )
  console.log(JSON.stringify({ type: 'result', status: 'success', stats: {} }))
  process.exit(0)
}
process.exit(1)
