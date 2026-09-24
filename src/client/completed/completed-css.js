/**
 * Scoped stylesheet for the completed turn card.
 *
 * Same delivery rule as the live pill: a module string rendered into one
 * reference-counted `<style data-plugin>` tag, because a DSH factory bundle has
 * no CSS import mechanism and the module system claims `style[data-plugin]` tags
 * for HMR bookkeeping.
 *
 * Rules:
 *   - every selector is scoped under `.dsh-tpm-root`; no element/global
 *     selectors, no body/typography pollution;
 *   - colours resolve through host `--dsw-*` alias tokens, so light and dark come
 *     from the active DSH theme rather than from a second theme system; the
 *     fallbacks exist only so a missing token degrades to a readable value;
 *   - the grid is `repeat(4, minmax(0, 1fr))` and collapses to `repeat(2, 1fr)`,
 *     never to a fixed rem width and never to horizontal overflow;
 *   - separators are logical-property borders, so they survive the two-column
 *     wrap without leaving a stray edge on the first cell of row two;
 *   - tabular digits everywhere; nothing here animates (the card is static).
 */

export const COMPLETED_STYLE_ID = 'dsh-tpm-completed-style'

export const COMPLETED_CSS = `
.dsh-tpm-root {
  --dsh-tpm-accent: #d9480f;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
body[data-ds-dark-theme] .dsh-tpm-root {
  --dsh-tpm-accent: #ff922b;
}
.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  padding: 10px 16px 8px;
  border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
  background: var(--dsw-specific-tip, rgba(127, 130, 135, .10));
  color: var(--dsw-alias-label-primary, #3c3c3d);
  font-size: 13px;
  line-height: 18px;
}
.dsh-tpm-cells {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: start;
}
.dsh-tpm-cell {
  min-width: 0;
  padding: 2px 14px;
  border-inline-start: .5px solid transparent;
}
.dsh-tpm-cell + .dsh-tpm-cell {
  border-inline-start-color: var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
}
.dsh-tpm-cell:first-child { padding-inline-start: 0; }
.dsh-tpm-cell:last-child { padding-inline-end: 0; }
.dsh-tpm-cell-label {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  margin: 3px 0 2px;
}
.dsh-tpm-cell-number {
  font-size: 19px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  white-space: nowrap;
}
.dsh-tpm-cell-unit {
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  white-space: nowrap;
}
.dsh-tpm-cell-sub {
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #7f8287);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-cell-sub[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, #b26a00); }
.dsh-tpm-cell-sub[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d03050); }
.dsh-tpm-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: .5px solid var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-foot-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tpm-foot-item + .dsh-tpm-foot-item::before {
  content: '·';
  margin-inline-end: 10px;
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
@media (max-width: 34rem) {
  .dsh-tpm-cells { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 10px; }
  .dsh-tpm-cell:nth-child(odd) {
    border-inline-start-color: transparent;
    padding-inline-start: 0;
  }
  .dsh-tpm-cell:nth-child(even) { padding-inline-end: 0; }
  .dsh-tpm-cell:nth-child(n + 3) {
    border-block-start: .5px solid var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
    padding-block-start: 8px;
  }
}
`
