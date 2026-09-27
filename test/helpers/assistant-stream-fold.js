/**
 * Faithful port of DSH 0.1.7-rc.2 `ClientAssistantStream` — the test oracle for
 * `settle-assistant` semantics.
 *
 * The browser never sees a raw fold decision; it sees only the resulting
 * `SessionEventWindow.change`. Testing the plugin against hand-written change
 * literals would therefore prove only that the plugin agrees with the test
 * author. This module reproduces the install's own algebra so the changes the
 * plugin consumes are **derived** from the durable rows and assistant frames
 * that a real session produces.
 *
 * Source of truth: `@deepseek-ai/dsh-api-session-controller/lib/client.js:1428-1543`
 * (class `ClientAssistantStream`, methods `replace`, `acceptDurable`,
 * `acceptFrame`, `attemptForSettlement`, `publish`) and
 * `lib/types/client/sessions/assistant-stream.d.ts:6-23` for the result union.
 *
 * The three findings this port exists to encode:
 *
 *   1. a durable, non-interrupted `assistant/message` that matches the open
 *      attempt is **staged** (`pending`) and published only when its `end` frame
 *      arrives — `acceptDurable` returns nothing until then;
 *   2. a successfully published non-interrupted `assistant/message` sets
 *      `retainedAttempt`, and the bare `settleAssistant(attemptId)` is issued
 *      when that attempt's `step/end` is published — a **retirement**, with no
 *      abandonment semantics at all;
 *   3. `outcome.kind === 'abandoned'` is the only path that yields an
 *      `abandonment` decision, and it is the same bare `settleAssistant` call on
 *      the wire.
 */

/**
 * One `ClientAssistantStream` instance.
 *
 * @param {{ publishedSeqs?: Iterable<number>, durableCursor?: number }} [initial]
 */
export function createAssistantStreamFold(initial = {}) {
  let activeAttempt
  let retainedAttempt
  const pending = new Map()
  const publishedSeqs = new Set(initial.publishedSeqs ?? [])
  let durableCursor = initial.durableCursor ?? -1
  let transientInGap = 0

  function isSettlementEntry(entry) {
    return entry?.event?.type === 'assistant/message' || entry?.event?.type === 'assistant/attempt'
  }

  function attemptForSettlement(event) {
    const attempt = activeAttempt
    if (attempt === undefined) return undefined
    // `surfaceOp` is carried on the wire form of a durable session event and is
    // `'append'` for every surface message this project records.
    if (event.type === 'assistant/message' && event.surfaceOp !== 'append') return undefined
    if (event.seq <= attempt.startedAfterSeq) return undefined
    if (attempt.turn !== event.data.turn || attempt.step !== event.data.step) return undefined
    return attempt
  }

  function publish(entry) {
    publishedSeqs.add(entry.event.seq)
    const retained = retainedAttempt
    if (
      retained !== undefined
      && entry.event.type === 'step/end'
      && entry.event.data.turn === retained.turn
      && entry.event.data.step === retained.step
    ) {
      retainedAttempt = undefined
      return { type: 'publish', entry, retireAttemptId: retained.attemptId }
    }
    return { type: 'publish', entry }
  }

  return {
    /** `acceptDurable(entry)` — one newly followed durable entry. */
    acceptDurable(entry) {
      const event = entry.event
      durableCursor = Math.max(durableCursor, event.seq)
      transientInGap = 0
      if (isSettlementEntry(entry) && attemptForSettlement(event) !== undefined) {
        if (pending.has(event.seq)) return { type: 'rebaseline' }
        pending.set(event.seq, entry)
        return undefined
      }
      return publish(entry)
    },

    /** `acceptFrame(frame)` — one dense transient assistant frame. */
    acceptFrame(frame) {
      switch (frame.type) {
        case 'start':
          if (activeAttempt !== undefined || retainedAttempt !== undefined || pending.size > 0) {
            return { type: 'rebaseline' }
          }
          activeAttempt = {
            attemptId: frame.attemptId,
            startedAfterSeq: frame.startedAfterSeq,
            turn: frame.turn,
            step: frame.step,
            nextIndex: 0,
          }
          return undefined
        case 'chunk': {
          const attempt = activeAttempt
          if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
          if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
          attempt.nextIndex += 1
          transientInGap += 1
          return {
            type: 'transient',
            entry: {
              type: 'transient',
              event: {
                type: 'assistant/live-chunk',
                seq: durableCursor + 1 - 1 / (transientInGap + 1),
                time: frame.time,
                data: {
                  attemptId: frame.attemptId,
                  turn: attempt.turn,
                  step: attempt.step,
                  chunk: frame.chunk,
                },
              },
            },
          }
        }
        case 'end': {
          const attempt = activeAttempt
          if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
          activeAttempt = undefined
          if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
          if (frame.outcome.kind === 'abandoned') {
            return pending.size === 0
              ? { type: 'abandonment', attemptId: attempt.attemptId }
              : { type: 'rebaseline' }
          }
          if (publishedSeqs.has(frame.outcome.seq)) return undefined
          const entry = pending.get(frame.outcome.seq)
          if (entry === undefined || entry.event.type !== frame.outcome.eventType) return { type: 'rebaseline' }
          pending.delete(frame.outcome.seq)
          if (entry.event.type === 'assistant/message' && entry.event.data.interrupted !== true) {
            retainedAttempt = { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step }
            return publish(entry)
          }
          publishedSeqs.add(entry.event.seq)
          return { type: 'settlement', attemptId: attempt.attemptId, entry }
        }
        default:
          return undefined
      }
    },

    /** Introspection for assertions about fold state. */
    state() {
      return {
        active: activeAttempt === undefined ? null : { ...activeAttempt },
        retained: retainedAttempt === undefined ? null : { ...retainedAttempt },
        pendingSeqs: [...pending.keys()],
        publishedSeqCount: publishedSeqs.size,
      }
    },
  }
}

/**
 * A `SessionEventSource` stand-in that reproduces `MutableSessionEventSource`
 * exactly (`dsh-api-session-controller/lib/types/client/contract/events.js:41-111`).
 *
 * `live-replay.js` has a simpler source; this one is used where the difference
 * matters — a `settle-assistant` inserts its entry **in seq order**, not at the
 * position of the transient rows it replaces, so a settlement can land below
 * entries the consumer has already processed.
 */
export function createWindowDriver() {
  let entries = []
  let snapshot = { entries, hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  const listeners = new Set()

  function publish(change) {
    snapshot = {
      entries,
      hasMore: false,
      revision: snapshot.revision + 1,
      change,
      // `entries` is a getter in the real snapshot; a plain array is equivalent
      // for a consumer that only reads it on `replace`.
    }
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
    revision: () => snapshot.revision,
    /** Every entry currently in the window, in order. */
    windowEntries: () => [...entries],

    replace(next) {
      entries = [...next]
      publish({ kind: 'replace', entries })
    },
    append(entry) {
      entries = [...entries, entry]
      publish({ kind: 'append', entries: [entry] })
    },
    prepend(older) {
      entries = [...older, ...entries]
      publish({ kind: 'prepend', entries: [...older] })
    },
    settleAssistant(attemptId, entry) {
      const kept = entries.filter(
        candidate => candidate.type !== 'transient' || candidate.event.data.attemptId !== attemptId,
      )
      if (entry !== undefined) {
        const index = kept.findIndex(candidate => candidate.event.seq > entry.event.seq)
        if (index < 0) kept.push(entry)
        else kept.splice(index, 0, entry)
      }
      entries = kept
      publish({ kind: 'settle-assistant', attemptId, ...(entry === undefined ? {} : { entry }) })
    },

    /** Apply one fold result exactly as the session does. */
    applyResult(result) {
      for (const change of changesForResult(result)) {
        if (change.kind === 'rebaseline') continue
        if (change.kind === 'settle-assistant') this.settleAssistant(change.attemptId, change.entry)
        else if (change.kind === 'append') for (const entry of change.entries) this.append(entry)
      }
    },
  }
}

/**
 * Translate one fold result into the `SessionEventWindow.change` the session
 * publishes for it (`dsh-api-session-controller/lib/client.js:617-648`).
 *
 * `settleAssistant(attemptId, entry)` inserts the settlement entry into the
 * window in seq order; a bare `settleAssistant(attemptId)` — issued for both a
 * retirement and an abandonment — carries no entry at all. That is precisely the
 * ambiguity the plugin has to resolve from its own held evidence.
 */
export function changesForResult(result) {
  if (result === undefined) return []
  switch (result.type) {
    case 'transient':
      return [{ kind: 'append', entries: [result.entry] }]
    case 'publish':
      return result.retireAttemptId === undefined
        ? [{ kind: 'append', entries: [result.entry] }]
        : [
          { kind: 'append', entries: [result.entry] },
          { kind: 'settle-assistant', attemptId: result.retireAttemptId },
        ]
    case 'settlement':
      return [{ kind: 'settle-assistant', attemptId: result.attemptId, entry: result.entry }]
    case 'abandonment':
      return [{ kind: 'settle-assistant', attemptId: result.attemptId }]
    case 'rebaseline':
      return [{ kind: 'rebaseline' }]
    default:
      return []
  }
}
