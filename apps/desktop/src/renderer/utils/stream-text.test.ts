import { describe, expect, it } from 'vitest'
import { appendLiveText } from './stream-text'

describe('appendLiveText', () => {
  it('appends ordinary streaming deltas', () => {
    expect(appendLiveText('目录是空的', '，我先写服务端')).toBe('目录是空的，我先写服务端')
  })

  it('ignores an exact duplicate chunk', () => {
    const sentence = '目录是空的，我先把服务端与几何/物理核心写出来。'
    expect(appendLiveText(sentence, sentence)).toBe(sentence)
  })

  it('ignores a duplicate chunk already contained in the accumulated text', () => {
    const sentence = '目录是空的，我先把服务端与几何/物理核心写出来。'
    const current = `${sentence}现在写联调自测脚本。`
    expect(appendLiveText(current, sentence)).toBe(current)
  })

  it('replaces with a cumulative replay instead of duplicating it', () => {
    const first = '目录是空的，我先把服务端与几何/物理核心写出来。'
    const cumulative = `${first}现在写联调自测脚本。`
    expect(appendLiveText(first, cumulative)).toBe(cumulative)
  })

  it('strips a repeated suffix overlap', () => {
    const repeated = '目录是空的，我先把服务端与几何/物理核心写出来。'
    const next = `${repeated}现在写联调自测脚本。`
    const current = '先读一下仓库。目录是空的，我先把服务端与几何/物理核心写出来。'
    expect(appendLiveText(current, next)).toBe(
      '先读一下仓库。目录是空的，我先把服务端与几何/物理核心写出来。现在写联调自测脚本。',
    )
  })
})
