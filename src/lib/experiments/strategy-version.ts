/**
 * strategy-version.ts — Strategy & Model Version Registry
 *
 * Every signal produced by the experiment framework carries three version
 * stamps:
 *   • strategyVersion  — the trading logic / rule set version
 *   • modelVersion     — the ML model artefact version (e.g. "ranker-v3")
 *   • featureVersion   — the feature-engineering pipeline version
 *
 * Together with `experimentId` these four fields make every signal fully
 * traceable and allow cross-version A/B attribution.
 *
 * Design notes
 * ────────────
 * • Versions are opaque strings so they can be semver, git SHAs, date
 *   stamps, or free-form labels without the registry caring.
 * • The registry is an in-process singleton — no persistence layer
 *   required. Experiment definitions (which *use* versions) are persisted
 *   by ExperimentManager.
 * • `resolveVersionTag()` supports symbolic aliases ("latest", "stable",
 *   "canary") so callers don't need to hard-code specific version strings.
 */

// ── Enums / union types ────────────────────────────────────────────────────────

/** High-level lifecycle phase of a version in the experiment pipeline. */
export type VersionStage =
  | "RESEARCH"   // Under active development — no signal generation
  | "BACKTEST"   // Being evaluated on historical data
  | "SHADOW"     // Receiving live data, generating signals, NO order impact
  | "PAPER"      // Active on paper portfolio, real market data, no real money
  | "LIVE";      // Production — real money, requires explicit human promotion

export type VersionStatus =
  | "ACTIVE"     // Currently running in its stage
  | "PAUSED"     // Temporarily suspended
  | "RETIRED"    // Superseded — no longer running
  | "FAILED";    // Terminated due to error or policy breach

// ── Version record ─────────────────────────────────────────────────────────────

export interface StrategyVersionMeta {
  /** Opaque version string (semver, SHA, timestamp, etc.). */
  version: string;
  /** Human-readable name for dashboards. */
  label: string;
  /** Optional change notes for this version. */
  changelog?: string;
  /** UTC ms when this version was registered. */
  registeredAtMs: number;
  /** The stage this version is currently in. */
  stage: VersionStage;
  /** Operational status within the stage. */
  status: VersionStatus;
  /** Free-form metadata (hyperparameters, feature list, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ModelVersionMeta {
  version: string;
  label: string;
  /** Python artefact path or URL (for reference only). */
  artefactPath?: string;
  changelog?: string;
  registeredAtMs: number;
  status: VersionStatus;
  metadata?: Record<string, unknown>;
}

export interface FeatureVersionMeta {
  version: string;
  label: string;
  /** Which features are included in this pipeline version. */
  features?: string[];
  changelog?: string;
  registeredAtMs: number;
  status: VersionStatus;
  metadata?: Record<string, unknown>;
}

// ── Stamped version set ────────────────────────────────────────────────────────

/**
 * The complete version stamp attached to every signal produced under an
 * experiment. Must match `SignalAttribution` fields used in the analytics
 * layer so attribution reports work without additional mapping.
 */
export interface VersionStamp {
  /** Strategy logic version. */
  strategyVersion: string;
  /** ML model artefact version. */
  modelVersion: string;
  /** Feature-engineering pipeline version. */
  featureVersion: string;
  /** Experiment that generated this signal. */
  experimentId: string;
}

// ── Aliases ────────────────────────────────────────────────────────────────────

type AliasMap = Map<string, string>; // alias → version string

// ── Registry ───────────────────────────────────────────────────────────────────

export class StrategyVersionRegistry {
  private readonly _strategies = new Map<string, StrategyVersionMeta>();
  private readonly _models = new Map<string, ModelVersionMeta>();
  private readonly _features = new Map<string, FeatureVersionMeta>();

  private readonly _strategyAliases: AliasMap = new Map();
  private readonly _modelAliases: AliasMap = new Map();
  private readonly _featureAliases: AliasMap = new Map();

  // ── Strategy versions ──────────────────────────────────────────────────

  registerStrategy(meta: Omit<StrategyVersionMeta, "registeredAtMs">): void {
    this._strategies.set(meta.version, {
      ...meta,
      registeredAtMs: Date.now(),
    });
  }

  getStrategy(version: string): StrategyVersionMeta | undefined {
    const resolved = this._strategyAliases.get(version) ?? version;
    return this._strategies.get(resolved);
  }

  listStrategies(): StrategyVersionMeta[] {
    return Array.from(this._strategies.values());
  }

  setStrategyAlias(alias: string, version: string): void {
    if (!this._strategies.has(version)) {
      throw new Error(`[VersionRegistry] Unknown strategy version: ${version}`);
    }
    this._strategyAliases.set(alias, version);
  }

  resolveStrategyAlias(aliasOrVersion: string): string {
    return this._strategyAliases.get(aliasOrVersion) ?? aliasOrVersion;
  }

  updateStrategyStage(version: string, stage: VersionStage): void {
    const meta = this._strategies.get(version);
    if (!meta) throw new Error(`[VersionRegistry] Unknown strategy version: ${version}`);
    meta.stage = stage;
  }

  updateStrategyStatus(version: string, status: VersionStatus): void {
    const meta = this._strategies.get(version);
    if (!meta) throw new Error(`[VersionRegistry] Unknown strategy version: ${version}`);
    meta.status = status;
  }

  // ── Model versions ─────────────────────────────────────────────────────

  registerModel(meta: Omit<ModelVersionMeta, "registeredAtMs">): void {
    this._models.set(meta.version, {
      ...meta,
      registeredAtMs: Date.now(),
    });
  }

  getModel(version: string): ModelVersionMeta | undefined {
    const resolved = this._modelAliases.get(version) ?? version;
    return this._models.get(resolved);
  }

  listModels(): ModelVersionMeta[] {
    return Array.from(this._models.values());
  }

  setModelAlias(alias: string, version: string): void {
    if (!this._models.has(version)) {
      throw new Error(`[VersionRegistry] Unknown model version: ${version}`);
    }
    this._modelAliases.set(alias, version);
  }

  resolveModelAlias(aliasOrVersion: string): string {
    return this._modelAliases.get(aliasOrVersion) ?? aliasOrVersion;
  }

  // ── Feature versions ───────────────────────────────────────────────────

  registerFeatures(meta: Omit<FeatureVersionMeta, "registeredAtMs">): void {
    this._features.set(meta.version, {
      ...meta,
      registeredAtMs: Date.now(),
    });
  }

  getFeatures(version: string): FeatureVersionMeta | undefined {
    const resolved = this._featureAliases.get(version) ?? version;
    return this._features.get(resolved);
  }

  listFeatures(): FeatureVersionMeta[] {
    return Array.from(this._features.values());
  }

  setFeatureAlias(alias: string, version: string): void {
    if (!this._features.has(version)) {
      throw new Error(`[VersionRegistry] Unknown feature version: ${version}`);
    }
    this._featureAliases.set(alias, version);
  }

  resolveFeatureAlias(aliasOrVersion: string): string {
    return this._featureAliases.get(aliasOrVersion) ?? aliasOrVersion;
  }

  // ── Cross-cutting helpers ──────────────────────────────────────────────

  /**
   * Build a complete VersionStamp for an experiment, resolving any aliases.
   */
  buildVersionStamp(
    strategyVersion: string,
    modelVersion: string,
    featureVersion: string,
    experimentId: string,
  ): VersionStamp {
    return {
      strategyVersion: this.resolveStrategyAlias(strategyVersion),
      modelVersion: this.resolveModelAlias(modelVersion),
      featureVersion: this.resolveFeatureAlias(featureVersion),
      experimentId,
    };
  }

  /**
   * Validate that all three versions in a stamp are registered.
   * Returns an array of error messages (empty = valid).
   */
  validateStamp(stamp: VersionStamp): string[] {
    const errors: string[] = [];
    if (!this._strategies.has(stamp.strategyVersion)) {
      errors.push(`Unknown strategyVersion: ${stamp.strategyVersion}`);
    }
    if (!this._models.has(stamp.modelVersion)) {
      errors.push(`Unknown modelVersion: ${stamp.modelVersion}`);
    }
    if (!this._features.has(stamp.featureVersion)) {
      errors.push(`Unknown featureVersion: ${stamp.featureVersion}`);
    }
    return errors;
  }

  // ── Serialisation ──────────────────────────────────────────────────────

  toJSON(): {
    strategies: StrategyVersionMeta[];
    models: ModelVersionMeta[];
    features: FeatureVersionMeta[];
  } {
    return {
      strategies: this.listStrategies(),
      models: this.listModels(),
      features: this.listFeatures(),
    };
  }
}

// ── Module-level singleton ─────────────────────────────────────────────────────

export const globalVersionRegistry = new StrategyVersionRegistry();
