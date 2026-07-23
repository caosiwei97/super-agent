import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderContextMatrix } from '../src/context/view.js'

describe('renderContextMatrix', () => {
  it('renders a 16x16 matrix and the real compaction buffer', () => {
    const output = renderContextMatrix({
      model: 'demo-model',
      contextWindowTokens: 16_000,
      compactionThresholdTokens: 12_000,
      systemTokens: 1_000,
      toolTokens: 500,
      messageTokens: 2_500,
    })
    const matrixRows = output.split('\n').filter(
      (line) => /^[●◆■○□](?: [●◆■○□]){15}$/.test(line),
    )

    assert.equal(matrixRows.length, 16)
    assert.match(output, /估算上下文: ~4\.0k\/16k tokens \(25\.0%\)/)
    assert.match(output, /Free space:\s+~8\.0k \(50\.0%\)/)
    assert.match(output, /Autocompact buffer:\s+~4\.0k \(25\.0%\)/)
  })

  it('reports overflow instead of producing a negative free-space slice', () => {
    const output = renderContextMatrix({
      model: 'small-model',
      contextWindowTokens: 1_000,
      compactionThresholdTokens: 750,
      systemTokens: 100,
      toolTokens: 100,
      messageTokens: 1_000,
    })

    assert.match(output, /Free space:\s+~0 \(0\.0%\)/)
    assert.match(output, /Autocompact buffer:\s+~0 \(0\.0%\)/)
    assert.match(output, /超出上下文窗口: ~200 tokens/)
  })
})
