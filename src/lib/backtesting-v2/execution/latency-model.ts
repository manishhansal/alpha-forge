/**
 * latency-model.ts — Signal-to-execution latency simulation for NSE/NFO.
 *
 * Three latency components are modelled:
 *   1. Signal latency    — time from bar close to strategy signal generation
 *                          (indicator computation, ML inference, etc.)
 *   2. Network latency   — time from signal to order reaching exchange
 *                          (co-location: ~1ms, retail API: 50–200ms)
 *   3. Order processing  — time from order receipt to exchange acknowledgement
 *                          (matching engine, queue depth, etc.)
 *
 * Three pre-built profiles:
 *   LOW    — co-located / institutional: total ~5–15ms
 *   MEDIUM — retail API (Zerodha/Upstox): total ~100–400ms
 *   HIGH   — slow API / congested session: total ~500–2000ms
 *
 * In backtesting all latency is "simulated" as a deterministic offset in
 * milliseconds stored on each fill record. It does NOT actually delay the
 * execution bar (that is controlled by validFromBarIndex), but it:
 *   a) Records realistic latency numbers in the fill for execution quality analysis
 *   b) Optionally skips fills if total latency exceeds the bar duration
 *      (i.e. the order arrived too late for this bar's open)
 *
 * Usage:
 *   const model = new LatencyModel(LatencyProfile.MEDIUM);
 *   const sample = model.sample();
 *   // sample.totalMs, sample.signalMs, sample.networkMs, sample.orderProcessingMs
 */

// ── Latency profile presets ───────────────────────────────────────────────────

export type LatencyProfileName = "LOW" | "MEDIUM" | "HIGH";

export interface LatencyBand {
  /** Minimum latency (ms). */
  minMs: number;
  /** Maximum latency (ms). */
  maxMs: number;
  /** Typical (mode) latency (ms) — used for deterministic mode. */
  typicalMs: number;
}

export interface LatencyProfileConfig {
  /** Signal computation latency (strategy + indicators). */
  signal: LatencyBand;
  /** Network round-trip to exchange. */
  network: LatencyBand;
  /** Order processing / queue time at exchange. */
  orderProcessing: LatencyBand;
  /**
   * If true, use `typicalMs` values for deterministic (reproducible) sampling.
   * If false, use uniform random within [minMs, maxMs].
   * Default: true for backtesting reproducibility.
   */
  deterministic: boolean;
}

const LOW_PROFILE: LatencyProfileConfig = {
  signal:          { minMs: 1,   maxMs: 5,   typicalMs: 2   },
  network:         { minMs: 1,   maxMs: 5,   typicalMs: 2   },
  orderProcessing: { minMs: 1,   maxMs: 5,   typicalMs: 3   },
  deterministic:   true,
};

const MEDIUM_PROFILE: LatencyProfileConfig = {
  signal:          { minMs: 10,  maxMs: 50,  typicalMs: 20  },
  network:         { minMs: 50,  maxMs: 200, typicalMs: 80  },
  orderProcessing: { minMs: 20,  maxMs: 150, typicalMs: 50  },
  deterministic:   true,
};

const HIGH_PROFILE: LatencyProfileConfig = {
  signal:          { minMs: 50,  maxMs: 300, typicalMs: 150 },
  network:         { minMs: 200, maxMs: 800, typicalMs: 400 },
  orderProcessing: { minMs: 100, maxMs: 500, typicalMs: 300 },
  deterministic:   true,
};

export const LatencyProfile: Record<LatencyProfileName, LatencyProfileConfig> = {
  LOW:    LOW_PROFILE,
  MEDIUM: MEDIUM_PROFILE,
  HIGH:   HIGH_PROFILE,
};

// ── Sample result ─────────────────────────────────────────────────────────────

export interface LatencySample {
  /** Latency from bar close to signal generation (ms). */
  signalMs: number;
  /** Network round-trip latency (ms). */
  networkMs: number;
  /** Order processing / queue latency at exchange (ms). */
  orderProcessingMs: number;
  /** Total signal-to-fill latency (ms). */
  totalMs: number;
}

// ── LatencyModel ──────────────────────────────────────────────────────────────

export class LatencyModel {
  private readonly profile: LatencyProfileConfig;

  constructor(profile: LatencyProfileConfig | LatencyProfileName = "MEDIUM") {
    this.profile = typeof profile === "string" ? LatencyProfile[profile] : profile;
  }

  /**
   * Draw a latency sample.
   * In deterministic mode returns `typicalMs` for each component.
   * In stochastic mode draws uniform random within [minMs, maxMs].
   */
  sample(): LatencySample {
    const { deterministic } = this.profile;
    const signalMs          = this._draw(this.profile.signal, deterministic);
    const networkMs         = this._draw(this.profile.network, deterministic);
    const orderProcessingMs = this._draw(this.profile.orderProcessing, deterministic);

    return {
      signalMs,
      networkMs,
      orderProcessingMs,
      totalMs: signalMs + networkMs + orderProcessingMs,
    };
  }

  /**
   * Return the typical (modal) total latency without randomness.
   * Useful for simple configuration checks.
   */
  get typicalTotalMs(): number {
    return (
      this.profile.signal.typicalMs +
      this.profile.network.typicalMs +
      this.profile.orderProcessing.typicalMs
    );
  }

  /** Profile name accessor (resolved from config comparison). */
  get profileName(): LatencyProfileName {
    if (this.profile === LOW_PROFILE)    return "LOW";
    if (this.profile === HIGH_PROFILE)   return "HIGH";
    return "MEDIUM";
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _draw(band: LatencyBand, deterministic: boolean): number {
    if (deterministic) return band.typicalMs;
    return band.minMs + Math.random() * (band.maxMs - band.minMs);
  }
}
