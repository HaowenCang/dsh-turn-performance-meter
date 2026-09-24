# Client implementation

The production component lives in `conversation.input.dock` — DSH's session-scoped list seat documented as
"Full-width entries above the composer card" — registered as the independent entry `turn-performance-meter` with
`order: 30` (the seat's shipped occupants are `todo` 0, `goal` 10, `queue` 20, so 30 lands last, immediately above
the composer card).

The native statistics keep their own seat: `client-ui-chat` `StatsPills` stays in `conversation.composer.dock`, below
the composer, at its own id `stats`. This plugin does not register there at all.

Structure:

- `live/` — the live pill and the shared presentation lifecycle. `cadence.js` owns the one presentation-cadence
  constant; `MeterRoot.js` owns the subscription, the ticker and the single style tag; `controller.js` wires the
  eventSource to the store and the presenter.
- `completed/` — the completed card and the curve view. `ui-model.js` (one level up) decides every visible string;
  `curve-view-model.js` decides every coordinate; `completed-tree.js`, `metric-cell.js` and `curve-tree.js` build
  element trees with no statistics in them; `view-mode.js` is the hover/focus state machine.
- `base-css.js` — the scoped tokens and type scale both view stylesheets consume.

Keep the live pill and completed card in one component tree, but keep their rendering branches separate. Do not
scrape another plugin's DOM, do not add another React runtime, and do not compute a metric outside `src/core`.
Every stylesheet selector stays scoped under `.dsh-tpm-root`; the only bare-`body` selector permitted is the
documented `body[data-ds-dark-theme] .dsh-tpm-root` theme override. See `docs/UI_SPEC.md` and
`docs/DSH_API_NOTES.md` for the semantics and the verified host contracts.
