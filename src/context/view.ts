const MATRIX_SIDE = 16
const MATRIX_CELLS = MATRIX_SIDE * MATRIX_SIDE

export interface ContextSnapshot {
  model: string
  contextWindowTokens: number
  compactionThresholdTokens: number
  systemTokens: number
  toolTokens: number
  messageTokens: number
}

interface ContextSlice {
  symbol: string
  tokens: number
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`
  }
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`
}

function percentage(tokens: number, total: number) {
  return total === 0 ? '0.0' : ((tokens / total) * 100).toFixed(1)
}

function allocateCells(slices: ContextSlice[], totalTokens: number) {
  if (totalTokens <= 0) return slices.map(() => 0)

  const exact = slices.map((slice) => (slice.tokens / totalTokens) * MATRIX_CELLS)
  const cells = exact.map(Math.floor)
  const remaining = MATRIX_CELLS - cells.reduce((sum, count) => sum + count, 0)
  const order = exact
    .map((value, index) => ({ index, remainder: value - cells[index] }))
    .sort((left, right) => right.remainder - left.remainder)

  for (let index = 0; index < remaining; index++) {
    cells[order[index % order.length].index]++
  }
  return cells
}

export function renderContextMatrix(snapshot: ContextSnapshot) {
  const windowTokens = Math.max(1, Math.floor(snapshot.contextWindowTokens))
  const thresholdTokens = Math.min(
    windowTokens,
    Math.max(1, Math.floor(snapshot.compactionThresholdTokens)),
  )
  const systemTokens = Math.max(0, Math.floor(snapshot.systemTokens))
  const toolTokens = Math.max(0, Math.floor(snapshot.toolTokens))
  const messageTokens = Math.max(0, Math.floor(snapshot.messageTokens))
  const usedTokens = systemTokens + toolTokens + messageTokens
  const visibleUsedTokens = Math.min(windowTokens, usedTokens)
  const overflowTokens = Math.max(0, usedTokens - windowTokens)
  const freeTokens = Math.max(0, thresholdTokens - visibleUsedTokens)
  const bufferTokens = Math.max(0, windowTokens - Math.max(thresholdTokens, visibleUsedTokens))

  // 超出窗口时优先保留真实的 system/tools 数量，最后截断消息在矩阵中的可见份额。
  const visibleSystemTokens = Math.min(systemTokens, windowTokens)
  const visibleToolTokens = Math.min(toolTokens, windowTokens - visibleSystemTokens)
  const visibleMessageTokens = Math.max(
    0,
    windowTokens - visibleSystemTokens - visibleToolTokens - freeTokens - bufferTokens,
  )
  const slices: ContextSlice[] = [
    { symbol: '●', tokens: visibleSystemTokens },
    { symbol: '◆', tokens: visibleToolTokens },
    { symbol: '■', tokens: visibleMessageTokens },
    { symbol: '○', tokens: freeTokens },
    { symbol: '□', tokens: bufferTokens },
  ]
  const counts = allocateCells(slices, windowTokens)
  const matrixSymbols = slices.flatMap((slice, index) =>
    Array.from({ length: counts[index] }, () => slice.symbol),
  )
  const matrix = Array.from({ length: MATRIX_SIDE }, (_, row) =>
    matrixSymbols.slice(row * MATRIX_SIDE, (row + 1) * MATRIX_SIDE).join(' '),
  )

  const usedPercentage = percentage(usedTokens, windowTokens)
  const legend = [
    `  ● System prompt:      ~${formatTokens(systemTokens)} (${percentage(systemTokens, windowTokens)}%)`,
    `  ◆ System tools:       ~${formatTokens(toolTokens)} (${percentage(toolTokens, windowTokens)}%)`,
    `  ■ Messages:           ~${formatTokens(messageTokens)} (${percentage(messageTokens, windowTokens)}%)`,
    `  ○ Free space:         ~${formatTokens(freeTokens)} (${percentage(freeTokens, windowTokens)}%)`,
    `  □ Autocompact buffer: ~${formatTokens(bufferTokens)} (${percentage(bufferTokens, windowTokens)}%)`,
  ]

  return [
    `${snapshot.model}`,
    `估算上下文: ~${formatTokens(usedTokens)}/${formatTokens(windowTokens)} tokens (${usedPercentage}%)`,
    `自动压缩水位: ${formatTokens(thresholdTokens)} (${percentage(thresholdTokens, windowTokens)}%)`,
    '',
    ...matrix,
    '',
    ...legend,
    ...(overflowTokens > 0 ? [`  ! 超出上下文窗口: ~${formatTokens(overflowTokens)} tokens`] : []),
  ].join('\n')
}
