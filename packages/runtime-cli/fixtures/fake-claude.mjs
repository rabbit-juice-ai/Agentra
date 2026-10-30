#!/usr/bin/env node
/**
 * 测试夹具：模拟 Claude Code 的 stream-json CLI。
 * 仅用于确定性集成测试（正常完成 / kill -9 / 认证失败 / 中断），不参与生产构建。
 *
 * 行为开关（通过 prompt 文本或环境变量）：
 * - prompt 含 CRASH     → 自杀 SIGKILL（模拟执行进程崩溃）
 * - prompt 含 HANG      → 只发 init，不发 result（模拟长任务，用于取消）
 * - prompt 含 FAIL      → result.is_error=true（模拟回合失败）
 * - FAKE_CLAUDE_AUTH=fail → auth status 返回 loggedIn=false；执行时退出码 1
 * - FAKE_CLAUDE_RUN_FAIL=1 → 执行时立即以退出码 1 失败
 */
import process from 'node:process'

const argv = process.argv.slice(2)

function argValue(flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : null
}

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (fake-claude)\n')
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_AUTH !== 'fail'
  process.stdout.write(
    `${JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? 'fake_token' : null,
      apiProvider: 'fake',
      configDirectory: '/tmp/fake-claude',
    })}\n`,
  )
  process.exit(0)
}

if (process.env.FAKE_CLAUDE_RUN_FAIL === '1') {
  process.stderr.write('fake-claude: simulated startup failure\n')
  process.exit(1)
}

if (process.env.FAKE_CLAUDE_AUTH === 'fail') {
  process.stderr.write('Invalid API key · Please run /login\n')
  process.exit(1)
}

const sessionId = argValue('--session-id') ?? argValue('--resume') ?? 'fake-session'
let initSent = false
let buffer = ''

function sendInit() {
  if (initSent) return
  initSent = true
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Read'],
    model: 'fake-model',
    permissionMode: 'dontAsk',
  })
}

function sendResult(text, isError = false) {
  emit({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: text,
    session_id: sessionId,
    num_turns: 1,
    total_cost_usd: 0,
  })
}

function handleUserText(text) {
  sendInit()
  if (text.includes('CRASH')) {
    process.kill(process.pid, 'SIGKILL')
    return
  }
  if (text.includes('HANG')) {
    return
  }
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
    session_id: sessionId,
  })
  if (text.includes('NORESULT')) return
  sendResult(`echo:${text}`, text.includes('FAIL'))
}

function handleFrame(frame) {
  if (frame.type === 'user') {
    const content = frame.message?.content
    const text = Array.isArray(content)
      ? content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      : typeof content === 'string'
        ? content
        : ''
    handleUserText(text)
    return
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id },
    })
    emit({ type: 'system', subtype: 'interrupt_received', session_id: sessionId })
    sendResult('interrupted', false)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length > 0) {
      try {
        handleFrame(JSON.parse(line))
      } catch {
        process.stderr.write(`fake-claude: unparsable frame: ${line}\n`)
      }
    }
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
