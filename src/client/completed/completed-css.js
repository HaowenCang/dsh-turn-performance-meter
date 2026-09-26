/**
 * Scoped stylesheet for the completed turn card.
 *
 * References: `docs/assets/reference-completed-summary.png` (the metric grid)
 * and `docs/assets/reference-hover-curve.png` (the alternate view). Both are
 * measured in `docs/IMPLEMENTATION_LOG.md`; the numbers that shaped this file:
 *
 *   - card surface `#f8f7f5` and a roughly 10 px corner radius;
 *   - **four equal columns** with a hairline between each and about 26 px of
 *     inline padding inside every column, so the first label's ink lands about
 *     26 px from the card edge;
 *   - a three-row rhythm per column: 13 px label, 22 px value, 12 px secondary,
 *     with 20 px of card padding above and below. That is about 113 px of card,
 *     which is what the reference measures;
 *   - the curve view replaces the **first two** columns with one panel spanning
 *     the same two grid tracks, so the generated-token and TTFT columns keep
 *     their exact positions and dividers across the switch.
 *
 * Both views are stacked in one grid cell (`.dsh-tpm-views`), which is what makes
 * the card height stable: the container is as tall as the taller view and a
 * switch cannot change it — at any width, at any host font size, and without
 * measuring anything in JavaScript.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

export const COMPLETED_STYLE_ID = 'dsh-tpm-completed-style'

export const COMPLETED_CSS = `
.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  max-width: min(100%, var(--dsh-composer-card-max-width, 100%));
  padding: calc(var(--dsh-tpm-font) * 1.55) 0;
  border-radius: 10px;
  border: .5px solid var(--dsh-tpm-hairline);
  background: var(--dsh-tpm-surface);
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.4;
}
/* The card is focusable only when it has an alternate view to reveal, and the
   ring is replaced rather than removed. */
.dsh-tpm-card:focus-visible {
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
  margin: calc(var(--dsh-tpm-font) * .6) calc(var(--dsh-tpm-font) * 2) 0;
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
