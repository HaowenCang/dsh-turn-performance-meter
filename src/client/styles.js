/**
 * Scoped style constants for the composer-dock meter.
 *
 * Every colour resolves through a host theme alias (`--dsw-*`) so the component
 * follows the active light/dark theme without a second theme system. The only
 * plugin-defined value is the output accent, which consumes the host business
 * accent where it exists and otherwise declares both palette modes explicitly —
 * `ctx.theme.overrideTokens` requires a `{ light, dark }` pair per token for
 * exactly this reason.
 *
 * The dock is a sibling below the composer card inside the composer stack, so
 * these rules must not assume they own a card.
 */

export const TPM_STYLE_TAG = 'dsh-turn-performance-meter/meter.css'

export const baseCss = `
.dsh-tpm-root {
  box-sizing: border-box;
  width: 100%;
  display: flex;
  justify-content: center;
}

.dsh-tpm-card {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%);
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-primary);
  padding: 8px 14px;
  font-size: 13px;
  line-height: 20px;
}

.dsh-tpm-pill {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  border-radius: 999px;
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}

.dsh-tpm-pill-value { font-size: 17px; font-weight: 600; }
.dsh-tpm-pill-unit { font-size: 12px; font-weight: 400; margin-left: 3px; color: var(--dsw-alias-label-secondary); }
.dsh-tpm-pill-sep { width: 1px; align-self: stretch; background: var(--dsw-alias-border-l1); }
.dsh-tpm-accent { color: var(--dsh-tpm-output-accent); }
.dsh-tpm-muted { color: var(--dsw-alias-label-tertiary); }

.dsh-tpm-columns { display: flex; align-items: stretch; gap: 0; }
.dsh-tpm-columns > * { flex: 1 1 0; min-width: 0; padding: 0 12px; }
.dsh-tpm-columns > * + * { border-left: .5px solid var(--dsw-alias-border-l1); }
.dsh-tpm-columns > *:first-child { padding-left: 0; }
.dsh-tpm-columns > *:last-child { padding-right: 0; }

.dsh-tpm-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-tpm-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-tpm-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* The curve view replaces the summary inside the same card; it is not a tooltip. */
.dsh-tpm-views { position: relative; }
.dsh-tpm-view { transition: opacity 220ms ease; }
.dsh-tpm-view[data-visible="false"] { opacity: 0; pointer-events: none; position: absolute; inset: 0; }

@media (prefers-reduced-motion: reduce) {
  .dsh-tpm-view { transition: none; }
}
`
