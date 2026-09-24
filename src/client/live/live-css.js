/**
 * Scoped stylesheet for the live meter.
 *
 * Delivered as a module string rather than a `.css` file because the DSH
 * browser module table loads a single classic script: there is no CSS import
 * mechanism inside a factory bundle, and a runtime-injected `<style>` is the
 * shipped pattern (the module system claims `style[data-plugin]` tags for HMR
 * bookkeeping — `dsh-client-modules/lib/client.js` `claimStyles`).
 *
 * Rules:
 *   - every selector is scoped under `.dsh-tpm-root`; no element/global
 *     selectors, no body/typography pollution;
 *   - colours come from host `--dsw-*` alias tokens so both themes follow the
 *     active DSH theme; fallbacks cover token absence;
 *   - the output accent is the one plugin-defined value, scoped to the root
 *     with a light default and the dark override keyed on
 *     `body[data-ds-dark-theme]`, the same selector the shipped theme CSS uses;
 *   - tabular digits for every number; no fixed viewport width (no
 *     `44.25rem`-style hard widths), so narrow docks wrap instead of
 *     overflowing horizontally;
 *   - `prefers-reduced-motion` disables the only transition.
 */

export const LIVE_STYLE_ID = 'dsh-tpm-live-style'

export const LIVE_CSS = `
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
.dsh-tpm-pill {
  box-sizing: border-box;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 5px 14px;
  border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
  background: var(--dsw-specific-tip, rgba(127, 130, 135, .10));
  color: var(--dsw-alias-label-primary, #3c3c3d);
  font-size: 13px;
  line-height: 20px;
  transition: opacity 160ms ease;
}
.dsh-tpm-lead {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-tpm-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-tps {
  color: var(--dsh-tpm-accent);
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: .01em;
}
.dsh-tpm-unit {
  font-size: 11px;
  font-weight: 400;
  color: var(--dsw-alias-label-secondary, #7f8287);
  margin-left: -4px;
}
.dsh-tpm-stage {
  color: var(--dsw-alias-label-secondary, #7f8287);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.dsh-tpm-sep {
  width: .5px;
  align-self: stretch;
  min-height: 16px;
  background: var(--dsw-alias-border-l1, rgba(127, 130, 135, .35));
  opacity: .8;
}
.dsh-tpm-elapsed {
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dsh-tpm-tool {
  color: var(--dsw-alias-label-primary, #3c3c3d);
  font-size: 13px;
  font-weight: 550;
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tpm-muted {
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tpm-pill { transition: none; }
}
`
