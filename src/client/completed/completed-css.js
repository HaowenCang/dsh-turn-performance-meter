/**
 * Scoped stylesheet for the completed turn card.
 *
 * ## Two reference layers, deliberately not mixed
 *
 * The **card surface** is no longer a measurement. Phase 9 takes it from the
 * official DSH TodoPanel, because the completed card and the todo panel are
 * sibling rows in one composer dock and two panels with different corners, fills
 * and shadows read as two plugins rather than as one product. The contract below
 * is copied from
 * `packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css` at
 * DSH `0.1.7-rc.2` (reference commit `477b4f4`), token for token — no sampled hex,
 * no hand-chosen radius, no fallback for a token this version is pinned to.
 *
 * The **expanded detail** keeps the Phase 5 metric grid, measured from
 * `docs/assets/reference-completed-summary.png` and
 * `docs/assets/reference-hover-curve.png`:
 *
 *   - **four equal columns** with a hairline between each, and the first label's
 *     ink 26 px from the card edge;
 *   - a three-row rhythm per column: 13 px label, 22 px value, 12 px secondary;
 *   - the curve view replaces the **first two** columns with one panel spanning
 *     the same two grid tracks, so the generated-token and TTFT columns keep
 *     their exact positions and dividers across the switch.
 *
 * The two layers meet at one number. The card shell now carries the host's
 * `padding: 6px 12px`, so the detail's own inline padding is `26px - 12px = 14px`
 * rather than the 26 px it used to carry alone: the reference geometry is a
 * *distance from the card edge*, not a padding of one particular element, and it
 * survives the shell change only because it is restated on the inner one.
 *
 * Both detail views are stacked in one grid cell (`.dsh-tpm-views`), which is
 * what makes the expanded card's height stable: the container is as tall as the
 * taller view and a switch cannot change it — at any width, at any host font size,
 * and without measuring anything in JavaScript.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

export const COMPLETED_STYLE_ID = 'dsh-tpm-completed-style'

/**
 * The host's dock geometry, as a repeated expression rather than a variable.
 *
 * DSH's TodoPanel writes the two `calc()`s out in full; this constant keeps the
 * two roots from drifting apart if a future phase has to revisit one of them,
 * while the emitted CSS stays the same tokens in the same order.
 */
const DOCK_WIDTH = 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))'
const DOCK_MAX_WIDTH = 'calc(var(--dsh-composer-card-max-width)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)'
  + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))'

export const COMPLETED_CSS = `
/* The dock seat. Width, centring and the panel surface come from the host's own
   dock formula, so the completed card's left and right edges land on the todo
   panel's rather than near them. The live pill keeps its own contract: it is a
   different row with a different reference and is not touched here. */
.dsh-tpm-root[data-kind="completed"] {
  box-sizing: border-box;
  width: ${DOCK_WIDTH};
  max-width: ${DOCK_MAX_WIDTH};
  margin: 0 auto;
  display: block;
  justify-content: flex-start;
}
/* The panel itself: TodoPanel's surface, unchanged. \`border: 0\` and the
   elevation-stroke variable are the host's pair — the hairline an outlined panel
   would draw is replaced by the elevation's own stroke, which is why the card
   below declares no border of its own. */
.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-panel);
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.4;
}
/* The host's body rhythm: 6px 12px with an 8px column gap. The gap is unused
   while collapsed, which is correct — a one-row panel is one row. */
.dsh-tpm-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
}
/* The whole header row is the button, as in the host. The background and border
   are reset rather than the button being replaced by a div, so the control keeps
   its keyboard and pointer semantics. */
.dsh-tpm-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.dsh-tpm-card-header:focus-visible {
  outline: 2px solid var(--dsh-tpm-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.dsh-tpm-card-lead {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-card-title {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #3c3c3d);
}
/* The one line the collapsed row is for. \`flex: auto\` with \`min-width: 0\` is what
   makes the ellipsis reachable: without the zero floor the flex item refuses to
   shrink below its content and the row pushes the chevron off the card instead. */
.dsh-tpm-card-progress {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-card-chevron {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
/* The detail is rendered only while expanded, so it needs no collapsed rule —
   there is no hidden state to keep out of the layout or the accessibility tree. */
.dsh-tpm-detail {
  display: flex;
  flex-direction: column;
  /* The reference keeps its first label 26px from the card edge; 12px of that is
     the shell's own inline padding. */
  padding: 4px 14px 0;
}
/* The detail is focusable only when it has an alternate view to reveal, and the
   ring is replaced rather than removed. */
.dsh-tpm-detail:focus-visible {
  outline: 2px solid var(--dsh-tpm-accent);
  outline-offset: 2px;
}
.dsh-tpm-views {
  display: grid;
}
.dsh-tpm-view {
  grid-area: 1 / 1;
  transition: opacity 220ms ease;
}
.dsh-tpm-view[data-visible="false"] {
  opacity: 0;
  pointer-events: none;
}
.dsh-tpm-cells {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: start;
}
.dsh-tpm-cell {
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
}
.dsh-tpm-cell + .dsh-tpm-cell,
.dsh-tpm-curve-panel + .dsh-tpm-cell {
  border-inline-start: .5px solid var(--dsh-tpm-hairline);
}
.dsh-tpm-cell-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-value {
  display: flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .28);
  min-width: 0;
  margin: calc(var(--dsh-tpm-font) * .3) 0 calc(var(--dsh-tpm-font) * .45);
}
.dsh-tpm-cell-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  line-height: 1.28;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  white-space: nowrap;
}
.dsh-tpm-cell[data-metric="outputTps"] .dsh-tpm-cell-number {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-cell-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.2;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
}
.dsh-tpm-cell-sub {
  font-size: calc(var(--dsh-tpm-font) * .92);
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-sub[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, #b26a00); }
.dsh-tpm-cell-sub[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d03050); }
.dsh-tpm-curve-panel {
  grid-column: span 2;
  min-width: 0;
  padding-inline: calc(var(--dsh-tpm-font) * 2);
  display: flex;
  flex-direction: column;
}
.dsh-tpm-curve-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(var(--dsh-tpm-font) * .75);
  min-width: 0;
  font-size: calc(var(--dsh-tpm-font) * .95);
  line-height: 1.45;
}
.dsh-tpm-legend {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .85);
  min-width: 0;
  overflow: hidden;
}
.dsh-tpm-legend-item {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .38);
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
}
.dsh-tpm-legend-item[data-absent="true"] { opacity: .45; }
.dsh-tpm-legend-swatch {
  width: calc(var(--dsh-tpm-font) * .5);
  height: calc(var(--dsh-tpm-font) * .5);
  border-radius: 1px;
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
  transform: translateY(-1px);
}
.dsh-tpm-legend-item[data-series="output"] .dsh-tpm-legend-swatch {
  background: var(--dsh-tpm-accent);
}
.dsh-tpm-peak {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .32);
  white-space: nowrap;
}
.dsh-tpm-peak-label { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-peak-value {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-peak-unit { color: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-plot {
  display: flex;
  align-items: stretch;
  height: calc(var(--dsh-tpm-font) * 3.7);
  margin-top: calc(var(--dsh-tpm-font) * .43);
  min-width: 0;
}
.dsh-tpm-plot-area {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-tpm-plot-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.dsh-tpm-series {
  fill: none;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dsh-tpm-series[data-series="reasoning"] { stroke: var(--dsw-alias-label-tertiary, #a2a4a6); }
.dsh-tpm-series[data-series="output"] { stroke: var(--dsh-tpm-accent); }
.dsh-tpm-connector {
  stroke-linecap: round;
}
.dsh-tpm-peak-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  margin: 0;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-peak-dot[data-leader="output"] { background: var(--dsh-tpm-accent); }
/*
   Two marker levels, because one size for both made a chart of many single-measurement
   stretches read as a field of peaks. 0.24 x font is roughly a quarter of the plot
   height and about half the previous 0.42, which was the size the peak uses and is
   the size that made dozens of ordinary beads dominate the trace; the opacity is kept
   below 1 for the same reason. The labels, the legend and the printed peak are
   unchanged, so nothing a reader relies on became smaller — only the decoration.
   Both tones resolve through DSH aliases, so light and dark themes follow the host
   without a second rule. */
.dsh-tpm-singleton-dot {
  position: absolute;
  width: calc(var(--dsh-tpm-font) * .24);
  height: calc(var(--dsh-tpm-font) * .24);
  margin: 0;
  border-radius: 50%;
  opacity: .75;
  transform: translate(-50%, -50%);
  background: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-singleton-dot[data-series="output"] { background: var(--dsh-tpm-accent); }
/* A singleton that *is* the published peak keeps the peak's own size: the peak dot
   is drawn at the same coordinate, and a smaller circle would leave a visible ring
   of the larger one behind it. */
.dsh-tpm-singleton-dot[data-peak="true"] {
  width: calc(var(--dsh-tpm-font) * .42);
  height: calc(var(--dsh-tpm-font) * .42);
  opacity: 1;
}
.dsh-tpm-axis-max {
  flex: 0 0 auto;
  align-self: flex-start;
  padding-inline-start: calc(var(--dsh-tpm-font) * .4);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-plot-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  font-size: calc(var(--dsh-tpm-font) * .92);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .35) calc(var(--dsh-tpm-font) * .8);
  /* The same 26px-from-the-card-edge rule as the cells, less the 14px the detail
     already carries. */
  margin: calc(var(--dsh-tpm-font) * .6) calc(var(--dsh-tpm-font) * .92) 0;
  padding-top: calc(var(--dsh-tpm-font) * .5);
  border-top: .5px solid var(--dsh-tpm-hairline);
  font-size: calc(var(--dsh-tpm-font) * .85);
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-foot-item + .dsh-tpm-foot-item::before {
  content: '·';
  margin-inline-end: calc(var(--dsh-tpm-font) * .8);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
@media (max-width: 34rem) {
  .dsh-tpm-cells {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: calc(var(--dsh-tpm-font) * .8);
  }
  .dsh-tpm-cell:nth-child(odd) { border-inline-start-color: transparent; }
  .dsh-tpm-cell:nth-child(n + 3) {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell {
    border-inline-start-color: transparent;
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
  .dsh-tpm-curve-panel + .dsh-tpm-cell + .dsh-tpm-cell {
    border-block-start: .5px solid var(--dsh-tpm-hairline);
    padding-block-start: calc(var(--dsh-tpm-font) * .6);
  }
}
`
