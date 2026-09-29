import { DELAY_BAND_COLORS, DELAY_BAND_LABELS, type DelayBand } from "./delayBands.js";

const BANDS: DelayBand[] = ["on_time", "minor", "moderate", "severe"];

/** Milestone 82: what each delay colour means, shown beside the toggle while it is on. Normal
 * blue is "no information" (no report, or off route) — said once here rather than as another
 * swatch that looks the same as every other occupied berth. */
export function DelayKey(): JSX.Element {
  return (
    <span className="map-page__delay-key" aria-label="Delay colour key">
      {BANDS.map((band) => (
        <span key={band} className="map-page__delay-key-item">
          <span
            className="map-page__delay-swatch"
            style={{
              background: DELAY_BAND_COLORS[band].fill,
              borderColor: DELAY_BAND_COLORS[band].stroke,
            }}
            aria-hidden="true"
          />
          {DELAY_BAND_LABELS[band]}
        </span>
      ))}
      <span className="map-page__delay-key-item">(blue: no report)</span>
    </span>
  );
}
