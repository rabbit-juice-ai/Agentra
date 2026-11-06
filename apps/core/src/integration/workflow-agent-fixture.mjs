#!/usr/bin/env node
// Deterministic CLI fixture, NOT a real model. Verifies that input contains actual artifact content.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('9.9.9 (workflow-fixture)'); process.exit(0) }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' })); process.exit(0) }
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`)
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
    emit({type: 'result', subtype: 'success', is_error: false, result: 'interrupted fixture turn'})
    return
  }
  if (frame.type !== 'user') return
  const prompt = frame.message.content.map(block => block.text ?? '').join('\n')
  if (prompt.startsWith('TASK_A_PAUSE_ONCE')) {
    const flag = path.join(process.cwd(), 'fixture-paused-once')
    if (!fs.existsSync(flag)) { fs.writeFileSync(flag, 'owned fixture marker', {flag: 'wx'}); return }
  }
  if (prompt.startsWith('HANG')) return
  let result
  let error = false
  if (prompt.startsWith('TASK_A')) {
    result = JSON.stringify({ agentraOutputVersion: 1, output: { passed: true }, artifacts: [{ name: 'spec', content: 'artifact-handoff-proof-A' }] })
  } else if (prompt.startsWith('TASK_B')) {
    error = !prompt.includes('artifact-handoff-proof-A')
    result = JSON.stringify({ agentraOutputVersion: 1, output: { consumed: !error }, artifacts: [{ name: 'implementation', content: 'artifact-handoff-proof-B' }] })
  } else if (prompt.startsWith('TASK_C')) {
    error = !prompt.includes('artifact-handoff-proof-B')
    result = JSON.stringify({ agentraOutputVersion: 1, output: { verified: !error }, artifacts: [{ name: 'final', content: 'workflow-completion-proof' }] })
  } else if (prompt.startsWith('EMPTY')) { result = '' }
  else if (prompt.startsWith('INVALID')) { result = '{invalid-json' }
  else { error = true; result = 'unexpected fixture task' }
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: result }] } })
  emit({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, result })
})
lines.on('close', () => process.exit(0))
