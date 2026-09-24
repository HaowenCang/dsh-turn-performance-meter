/**
 * Locale dictionary and translate wrapper.
 *
 * Visible production strings go through the DSH Client locale service
 * (`ctx.locale.register(ns, {en, zh})` + `ctx.locale.bind(ns)`, verified at
 * `dsh-client-locale/lib/types/client/index.d.ts:198-215`). The wrapper keeps
 * an in-module English fallback so a locale-service failure degrades to a
 * readable label instead of to raw keys.
 *
 * Tool names and numeric units stay locale-independent: `tokens/s` and the
 * `pwsh +1` count suffix are identical in both locales, which is also what the
 * reference screenshots show.
 */

export const LOCALE_NS = 'turnPerformanceMeter'

export const LOCALE_DICTS = Object.freeze({
  en: Object.freeze({
    meterLabel: 'Live turn performance',
    ttft: 'first response timer',
    thinking: 'thinking',
    output: 'output',
    waiting: 'waiting for model',
    transition: 'processing',
    tool: 'tool',
    tpsUnit: 'tokens/s',
    // Completed card: four principal column labels, then the footer/status copy.
    completedLabel: 'Turn performance summary',
    colReasoningTps: 'Reasoning TPS',
    colOutputTps: 'Output TPS',
    colGeneratedTokens: 'Generated Tokens',
    colTtft: 'TTFT',
    elapsed: 'elapsed',
    tools: 'tools',
    attempts: 'attempts',
    'status.completed': 'completed',
    'status.interrupted': 'interrupted',
    'status.errored': 'errored',
    'status.max-tokens': 'token limit reached',
    turnLabel: 'turn',
    unavailable: 'unavailable',
    'quality.exact': 'exact',
    'quality.approximate': 'approximate',
  }),
  zh: Object.freeze({
    meterLabel: '实时性能',
    ttft: '首响应计时',
    thinking: '思考',
    output: '输出',
    waiting: '等待模型',
    transition: '处理中',
    tool: '工具',
    tpsUnit: 'tokens/s',
    completedLabel: '本轮性能统计',
    colReasoningTps: '思考 TPS',
    colOutputTps: '输出 TPS',
    colGeneratedTokens: '生成 Tokens',
    colTtft: '首响应',
    elapsed: '总用时',
    tools: '工具',
    attempts: '模型调用',
    'status.completed': '已完成',
    'status.interrupted': '已中断',
    'status.errored': '出错',
    'status.max-tokens': '达到 Token 上限',
    turnLabel: '第',
    unavailable: '不可用',
    'quality.exact': '精确',
    'quality.approximate': '近似',
  }),
})

/**
 * Wrap the locale-bound translate function with an English fallback.
 *
 * `bind(ns)` returns a function looked up against the active language at call
 * time, so locale switches are picked up on the next render. If the service is
 * absent, throws, or returns the key itself, the built-in `en` entry (or the
 * key) is used — never `undefined` in visible UI.
 *
 * @param {unknown} rawT the `ctx.locale.bind(LOCALE_NS)` result, or null
 * @returns {(key: string) => string}
 */
export function wrapTranslate(rawT) {
  return (key) => {
    if (typeof rawT === 'function') {
      try {
        const value = rawT(key)
        if (typeof value === 'string' && value.length > 0 && value !== key) return value
      } catch { /* fall through to the built-in dictionary */ }
    }
    return LOCALE_DICTS.en[key] ?? key
  }
}
