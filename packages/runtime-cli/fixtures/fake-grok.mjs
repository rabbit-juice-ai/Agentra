#!/usr/bin/env node
// Deterministic Grok CLI fixture for provider lifecycle tests.
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('grok 1.0.5 (fixture)')
  process.exit(0)
}
if (args[0] === 'models') {
  console.log('You are not authenticated.')
  process.exit(0)
}
const pIndex = args.indexOf('-p')
if (pIndex >= 0) {
  const prompt = args[pIndex + 1] ?? ''
  if (prompt.includes('FAIL')) {
    console.log(JSON.stringify({ type: 'result', is_error: true, error: { message: 'fixture failure' } }))
    process.exit(1)
  }
  console.log(
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }),
  )
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'OK' }))
  process.exit(0)
}
process.exit(1)
