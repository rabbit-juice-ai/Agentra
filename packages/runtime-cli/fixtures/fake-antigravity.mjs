#!/usr/bin/env node
// Deterministic Antigravity CLI fixture for provider lifecycle tests.
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('agy 1.4.0 (fixture)')
  process.exit(0)
}
if (args[0] === 'models') {
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)')
  console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)')
  process.exit(0)
}
const promptIndex = args.indexOf('-p')
if (promptIndex >= 0) {
  const prompt = args[promptIndex + 1] ?? ''
  console.log(JSON.stringify({ event: 'init', permission_mode: 'default' }))
  if (prompt.includes('FAIL')) {
    console.log(
      JSON.stringify({
        event: 'result',
        result: { status: 'ERROR', error: 'fixture failure' },
      }),
    )
    process.exit(1)
  }
  console.log(
    JSON.stringify({ event: 'step_update', step_update: { text_delta: 'O' } }),
  )
  console.log(
    JSON.stringify({ event: 'step_update', step_update: { text_delta: 'K' } }),
  )
  console.log(
    JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'OK', conversation_id: 'conv-1' },
    }),
  )
  process.exit(0)
}
process.exit(1)
