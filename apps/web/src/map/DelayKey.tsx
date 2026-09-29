import { DELAY_BAND_COLORS, DELAY_BAND_LABELS, type DelayBand } from "./delayBands.js";

const BANDS: DelayBand[] = ["minor", "moderate", "severe"];

/** Milestone 82: what each delay colour means, shown beside the toggle while it is on. Normal
 * blue is "under 15 minutes late, or no report" — said once here rather than as a fourth swatch
 * that looks the same as every other occupied berth. */
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
      <span className="map-page__delay-key-item">(blue: under 15 min or no report)</span>
    </span>
  );
}
