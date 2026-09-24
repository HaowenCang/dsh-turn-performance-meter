/**
 * Scoped stylesheet for the live meter.
 *
 * Reference: `docs/assets/reference-live-ttft.png` and
 * `docs/assets/reference-live-streaming.png`. Measured from those captures,
 * corrected to CSS pixels against the composer placeholder's ink height: a
 * centred horizontal pill roughly 49 px tall, radius about 10 px, one filled
 * surface, and a single dominant number per state.
 *
 * What that measurement changed, relative to the functional skeleton:
 *
 *   - the reference's first visual focus is the *number*, not a text row. Each
 *     state therefore renders its number through `.dsh-tpm-number` at
 *     `1.7 x` the host content size, and everything else is `0.95 x`-`1.25 x`;
 *   - the unit is a separate baseline-aligned run at `0.95 x` instead of being
 *     glued to the digits at the same size;
 *   - the pill keeps the reference's generous horizontal padding (about 1.55 em)
 *     so the number is not crowded against the border;
 *   - the separator is a hairline that stretches the content height, which is
 *     what makes one pill read as two regions rather than one run-on sentence.
 *
 * Delivery and scoping rules are documented once in `../base-css.js`.
 */

export const LIVE_STYLE_ID = 'dsh-tpm-live-style'

export const LIVE_CSS = `
.dsh-tpm-pill {
  box-sizing: border-box;
  max-width: min(100%, var(--dsh-composer-card-max-width, 100%));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: calc(var(--dsh-tpm-font) * .5);
  padding: calc(var(--dsh-tpm-font) * .62) calc(var(--dsh-tpm-font) * 1.55);
  border-radius: 10px;
  border: .5px solid var(--dsh-tpm-hairline);
  background: var(--dsh-tpm-surface);
  color: var(--dsw-alias-label-primary, #3c3c3d);
  line-height: 1.25;
}
.dsh-tpm-number {
  font-size: calc(var(--dsh-tpm-font) * 1.7);
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -.01em;
  color: var(--dsw-alias-label-primary, #3c3c3d);
}
.dsh-tpm-number[data-tone="accent"] {
  color: var(--dsh-tpm-accent);
}
.dsh-tpm-unit {
  font-size: calc(var(--dsh-tpm-font) * .95);
  font-weight: 400;
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-label {
  font-size: calc(var(--dsh-tpm-font) * .95);
  color: var(--dsw-alias-label-tertiary, #a2a4a6);
}
.dsh-tpm-stage {
  font-size: calc(var(--dsh-tpm-font) * 1.15);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-elapsed {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  color: var(--dsw-alias-label-secondary, #7f8287);
}
.dsh-tpm-tool {
  font-size: calc(var(--dsh-tpm-font) * 1.25);
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #3c3c3d);
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tpm-sep {
  width: .5px;
  align-self: stretch;
  min-height: calc(var(--dsh-tpm-font) * 1.6);
  background: var(--dsh-tpm-hairline);
}
/* A number and its unit are one visual token: keep them from wrapping apart. */
.dsh-tpm-metric {
  display: inline-flex;
  align-items: baseline;
  gap: calc(var(--dsh-tpm-font) * .25);
  white-space: nowrap;
}
`
