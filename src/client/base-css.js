/**
 * Shared scoped tokens for the plugin's two stylesheets.
 *
 * Delivered as a module string for the same reason as the view stylesheets: a
 * DSH factory bundle has no CSS import mechanism, and the module system claims
 * `style[data-plugin]` tags for HMR bookkeeping. `MeterRoot.js` concatenates
 * this block with the live and completed sheets into one tag.
 *
 * Rules:
 *   - every selector is scoped under `.dsh-tpm-root`; the only exception is the
 *     documented `body[data-ds-dark-theme] .dsh-tpm-root` theme override, which
 *     is the selector the shipped DSH theme CSS itself uses;
 *   - no element selectors, no `body` typography, no global `div`/`span`/`svg`
 *     rules — the plugin must not be able to restyle anything it does not own;
 *   - every colour resolves through a host `--dsw-*` alias token so light and
 *     dark come from the active DSH theme; the fallbacks exist only so a missing
 *     token degrades to a readable value;
 *   - **one type scale.** `--dsh-tpm-font` follows the host's secondary content
 *     size (the same variable `StatsPills` reads), and every other size is a
 *     multiple of it. A user who changes DSH's font size therefore scales the
 *     whole meter with the surrounding UI instead of leaving one card behind.
 */

/**
 * `--dsh-tpm-accent` is the plugin's single self-defined value.
 *
 * Measured from `docs/assets/reference-completed-summary.png`, whose output-rate
 * number is `#fb8147`. That exact value scores 2.31:1 against the reference's own
 * card surface, which is below the 3:1 floor for large text, so the shipped
 * accent keeps the reference's hue (about 21 degrees) and darkens it to 3.4:1 —
 * closer to the reference than the previous `#d9480f` while remaining legible.
 * `docs/IMPLEMENTATION_LOG.md` records the measurement and the deviation.
 */
export const BASE_STYLE_ID = 'dsh-tpm-base-style'

export const BASE_CSS = `
.dsh-tpm-root {
  --dsh-tpm-font: var(--dsh-content-font-size-secondary, 13px);
  --dsh-tpm-accent: #d9600f;
  --dsh-tpm-surface: var(--dsw-alias-bg-module-platform, var(--dsw-specific-tip, rgba(127, 130, 135, .10)));
  --dsh-tpm-hairline: var(--dsw-alias-separator-primary, var(--dsw-alias-border-l1, rgba(127, 130, 135, .28)));
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: flex;
  justify-content: center;
  font-size: var(--dsh-tpm-font);
  font-variant-numeric: tabular-nums;
}
body[data-ds-dark-theme] .dsh-tpm-root {
  --dsh-tpm-accent: #ff9a5c;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tpm-root * {
    transition: none !important;
    animation: none !important;
  }
}
`
