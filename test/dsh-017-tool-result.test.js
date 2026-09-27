/**
 * Phase 7D — the DSH 0.1.7-rc.2 `tool/result` contract.
 *
 * The local 0.1.7 install makes the tool result a **first-class tool-role
 * message** that owns its call identity and its failure flag
 * (`dsh-llm/lib/types/message.d.ts:152-160`):
 *
 *     interface ToolResultMessage extends MessageBase {
 *       readonly role: 'tool'
 *       readonly source: ToolMessageSource
 *       readonly toolCallId: ToolCallId   // provider-issued call id
 *       readonly isError?: boolean        // whether the invocation failed
 *     }
 *
 * and the durable event carries it whole
 * (`dsh-session/lib/types/types.d.ts:374-388`):
 *
 *     'tool/result': { turn, step, message: ToolResultMessage,
 *                      error?: {name, code, reason?}, meta? }
 *
 * The pre-7D parser read `data.message.content[0].toolCallId`. In 0.1.7 the
 * content blocks are the result **content** and carry no call identity at all,
 * so that read yields `null` for every real tool result and no call ever pairs.
 *
 * These tests are written against the exact local shape; the first block is the
 * regression that reproduces the defect at the recorded baseline SHA.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { NORMALIZED_KIND, TOOL_RESULT_SHAPE, normalizeDurableEvent } from '../src/dsh/index.js'

/** One exact 0.1.7 `tool/result` durable event, with the fields the install declares. */
function toolResult017({ seq = 42, time = 1790229022193, turn = 1, step = 1, callId = 'call-1', isError, content, error, meta } = {}) {
  const message = {
    id: 'msg-8f14e45f',
    role: 'tool',
    source: { kind: 'tool', callId },
    content: content ?? [{ type: 'text', text: 'alpha-7' }],
  }
  if (callId !== null) message.toolCallId = callId
  if (isError !== undefined) message.isError = isError
  const data = { turn, step, message }
  if (error !== undefined) data.error = error
  if (meta !== undefined) data.meta = meta
  return { type: 'tool/result', seq, time, data }
}

test('0.1.7 tool/result reads the call identity from the tool-role message', () => {
  const normalized = normalizeDurableEvent(toolResult017({ callId: 'call-1' }))
  assert.equal(normalized.kind, NORMALIZED_KIND.TOOL_RESULT)
  assert.equal(normalized.callId, 'call-1', 'data.message.toolCallId is the authoritative identity')
  assert.equal(normalized.callIdSource, TOOL_RESULT_SHAPE.TOOL_MESSAGE)
  assert.equal(normalized.status, 'ok', 'a result without a failure flag is ok')
  assert.equal(normalized.timeMs, 1790229022193, 'the envelope carries the timestamp')
})

test('0.1.7 content blocks are result content and never supply the call identity', () => {
  /**
   * The counterexample the pre-7D parser fails: a real 0.1.7 result whose
   * content is the tool's own payload. Nothing in `content` names the call.
   */
  const normalized = normalizeDurableEvent(toolResult017({
    callId: 'call-99',
    content: [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ],
  }))
  assert.equal(normalized.callId, 'call-99')

  /**
   * And the converse: content that *does* carry a stale `toolCallId` (the 0.1.5
   * nesting) must not override the message field for a tool-role message.
   */
  const shadowed = normalizeDurableEvent(toolResult017({
    callId: 'call-truth',
    content: [{ type: 'tool-result', toolCallId: 'call-stale', content: [], isError: true }],
  }))
  assert.equal(shadowed.callId, 'call-truth', 'the message field wins for a tool-role message')
  assert.equal(shadowed.status, 'ok', 'a nested isError is not the 0.1.7 failure flag')
})

test('0.1.7 failure evidence: message.isError and data.error both settle the call as failed', () => {
  const flagOnly = normalizeDurableEvent(toolResult017({ callId: 'call-2', isError: true }))
  assert.equal(flagOnly.status, 'error')
  assert.equal(flagOnly.errorName, null, 'no structured failure identity was reported')

  const structuredOnly = normalizeDurableEvent(toolResult017({
    callId: 'call-3',
    error: { name: 'ToolFailure', code: 'E_FAIL', reason: 'the command failed' },
  }))
  assert.equal(structuredOnly.status, 'error', 'data.error alone proves the failure')
  assert.equal(structuredOnly.errorName, 'ToolFailure')
  assert.equal(structuredOnly.errorCode, 'E_FAIL')

  const both = normalizeDurableEvent(toolResult017({
    callId: 'call-4',
    isError: true,
    error: { name: 'ToolFailure', code: 'E_FAIL' },
  }))
  assert.equal(both.status, 'error')
  assert.equal(both.callId, 'call-4', 'the call still settles by its identity')

  const neither = normalizeDurableEvent(toolResult017({ callId: 'call-5', isError: false }))
  assert.equal(neither.status, 'ok')
})

test('a 0.1.7 tool result without a call identity fails closed', () => {
  /**
   * §6: the identity is authoritative. An absent `message.toolCallId` must not be
   * repaired by guessing the most recent call, matching by name, matching by
   * step, or closing every running call.
   */
  const malformed = normalizeDurableEvent(toolResult017({ callId: null }))
  assert.equal(malformed.kind, NORMALIZED_KIND.TOOL_RESULT)
  assert.equal(malformed.callId, null, 'no identity is invented')
  assert.equal(malformed.callIdSource, TOOL_RESULT_SHAPE.MALFORMED)
  assert.equal(malformed.malformed, true, 'the caller is told the result is unusable')

  const empty = normalizeDurableEvent(toolResult017({ callId: '' }))
  assert.equal(empty.callId, null)
  assert.equal(empty.malformed, true)
})

test('a recorded 0.1.5 tool result is decoded only as an explicitly labelled legacy shape', () => {
  /**
   * `fixtures/dsh-turns/*` were recorded on 0.1.5-rc.2, where the result was a
   * `user`-role message whose first content block owned `toolCallId`/`isError`.
   * That shape is kept for the metric-math regressions that replay those bytes,
   * and it is tagged so no caller can mistake it for 0.1.7 evidence.
   */
  const legacy = normalizeDurableEvent({
    type: 'tool/result',
    seq: 18,
    time: 1790229022193,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-legacy', content: [], isError: false }],
      },
    },
  })
  assert.equal(legacy.callId, 'call-legacy')
  assert.equal(legacy.callIdSource, TOOL_RESULT_SHAPE.LEGACY_CONTENT_BLOCK)
  assert.equal(legacy.status, 'ok')

  const legacyError = normalizeDurableEvent({
    type: 'tool/result',
    seq: 20,
    time: 1790229022293,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-legacy-2', content: [], isError: true }] },
    },
  })
  assert.equal(legacyError.status, 'error', 'the legacy flag is read only on the legacy shape')
})

test('a tool-role message is never decoded from the legacy content block', () => {
  /**
   * The discriminator is structural (`message.role`), not positional: once a
   * message declares itself a tool-role message it is read the 0.1.7 way, even
   * when it is malformed. This is what makes the legacy path unreachable for
   * 0.1.7 evidence rather than a silent fallback over it.
   */
  const malformedToolRole = normalizeDurableEvent({
    type: 'tool/result',
    seq: 30,
    time: 1790229022393,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-should-be-ignored', content: [], isError: true }],
      },
    },
  })
  assert.equal(malformedToolRole.callId, null)
  assert.equal(malformedToolRole.callIdSource, TOOL_RESULT_SHAPE.MALFORMED)
  assert.equal(malformedToolRole.status, 'ok', 'a nested isError is not consulted for a tool-role message')
})
