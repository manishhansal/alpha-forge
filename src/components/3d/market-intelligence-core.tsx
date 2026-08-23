"use client";

/**
 * MarketIntelligenceCore
 *
 * A React Three Fiber scene that renders a living 3D sphere whose visual
 * state directly encodes four market dimensions:
 *
 *   • Regime   → overall color tint (green / neutral / red)
 *   • Volatility → surface distortion / wireframe density
 *   • Breadth  → particle cloud density around the sphere
 *   • VIX      → rotation speed and turbulence
 *
 * The component accepts all values as props so it is easy to test in
 * isolation. Integration into the dashboard reads from the India market
 * store in the parent wrapper component.
 *
 * Code-split: the Canvas import stays inside this file so Next.js only
 * loads Three.js on pages that mount this component.
 */

import * as React from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sparkles, MeshDistortMaterial } from "@react-three/drei";
import * as THREE from "three";

/* ── Types ───────────────────────────────────────────────────────────────── */

export type MarketRegime = "BULL" | "BEAR" | "SIDEWAYS" | "UNKNOWN";

export interface MarketCoreProps {
  /** Overall market regime — drives color temperature. */
  regime: MarketRegime;
  /**
   * Normalised volatility 0–1.
   * 0 = calm market, 1 = extreme volatility (maps from India VIX 10–40+).
   */
  volatility: number;
  /**
   * Normalised breadth 0–1.
   * Fraction of tracked indices / sectors that are positive.
   */
  breadth: number;
  /**
   * Absolute VIX value — used for rotation speed.
   * Typical range 10–35.
   */
  vix?: number;
  /** Canvas pixel height. Defaults to 260. */
  height?: number;
}

/* ── Colour palette ──────────────────────────────────────────────────────── */

// Maps regime → [core color, emissive color, particle color]
const REGIME_COLORS: Record<
  MarketRegime,
  { core: string; emissive: string; particles: string }
> = {
  BULL:     { core: "#10d079", emissive: "#0a8c4e", particles: "#5fffb0" },
  SIDEWAYS: { core: "#60a5fa", emissive: "#1e40af", particles: "#93c5fd" },
  BEAR:     { core: "#f43f5e", emissive: "#9f1239", particles: "#fb7185" },
  UNKNOWN:  { core: "#94a3b8", emissive: "#334155", particles: "#cbd5e1" },
};

/* ── Core sphere ─────────────────────────────────────────────────────────── */

function CoreSphere({
  regime,
  volatility,
  breadth,
  vix = 15,
}: Omit<MarketCoreProps, "height">) {
  const meshRef = React.useRef<THREE.Mesh>(null!);
  const ringRef = React.useRef<THREE.Mesh>(null!);

  const palette  = REGIME_COLORS[regime];
  const coreCol  = React.useMemo(() => new THREE.Color(palette.core),     [palette.core]);
  const emitCol  = React.useMemo(() => new THREE.Color(palette.emissive), [palette.emissive]);

  // Lerp targets so transitions are smooth when props change
  const targetDistort = React.useRef(volatility * 0.55 + 0.05);
  const targetSpeed   = React.useRef(volatility * 0.6  + 0.2);

  React.useEffect(() => {
    targetDistort.current = volatility * 0.55 + 0.05;
    targetSpeed.current   = volatility * 0.6  + 0.2;
  }, [volatility]);

  // Scale encodes breadth: 0.85 (bearish) → 1.15 (high breadth)
  const targetScale = React.useRef(0.85 + breadth * 0.3);
  React.useEffect(() => {
    targetScale.current = 0.85 + breadth * 0.3;
  }, [breadth]);

  // VIX → rotation speed
  const baseRotSpeed = Math.min((vix / 20) * 0.006, 0.014);

  useFrame((_, delta) => {
    if (!meshRef.current) return;

    // Smooth rotation
    meshRef.current.rotation.y += baseRotSpeed + volatility * 0.004;
    meshRef.current.rotation.x += baseRotSpeed * 0.3;

    // Scale lerp
    const s = meshRef.current.scale.x;
    const ts = targetScale.current;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(s, ts, delta * 2));

    // Ring counter-rotation
    if (ringRef.current) {
      ringRef.current.rotation.z += 0.004;
      ringRef.current.rotation.x = 0.4;
    }
  });

  return (
    <group>
      {/* Outer ambient glow (additive blending large sphere) */}
      <mesh scale={1.45}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial
          color={coreCol}
          transparent
          opacity={0.04}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Main distorted sphere */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 128, 128]} />
        <MeshDistortMaterial
          color={coreCol}
          emissive={emitCol}
          emissiveIntensity={0.45}
          distort={targetDistort.current}
          speed={targetSpeed.current}
          roughness={0.15}
          metalness={0.6}
          transparent
          opacity={0.92}
        />
      </mesh>

      {/* Equatorial ring */}
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.3, 0.012, 16, 120]} />
        <meshBasicMaterial color={coreCol} transparent opacity={0.35} />
      </mesh>

      {/* Inner wireframe shell — density tied to volatility */}
      <mesh scale={1.01}>
        <sphereGeometry args={[1, Math.round(8 + volatility * 20), Math.round(8 + volatility * 20)]} />
        <meshBasicMaterial
          color={palette.particles}
          wireframe
          transparent
          opacity={0.06 + volatility * 0.10}
        />
      </mesh>
    </group>
  );
}

/* ── Particle cloud ──────────────────────────────────────────────────────── */

function ParticleCloud({
  regime,
  breadth,
  volatility,
}: Pick<MarketCoreProps, "regime" | "breadth" | "volatility">) {
  const palette = REGIME_COLORS[regime];
  // More particles when breadth is high (healthy market)
  const count = Math.round(30 + breadth * 120);
  // Particles spread further when volatility is high
  const size = 0.03 + volatility * 0.04;

  return (
    <Sparkles
      count={count}
      scale={3.8}
      size={size}
      speed={0.2 + volatility * 0.6}
      opacity={0.55 + breadth * 0.35}
      color={palette.particles}
    />
  );
}

/* ── Lighting ────────────────────────────────────────────────────────────── */

function Lighting({ regime }: { regime: MarketRegime }) {
  const palette = REGIME_COLORS[regime];
  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[4, 4, 4]}   intensity={1.8} color={palette.core} />
      <pointLight position={[-4, -2, -4]} intensity={0.8} color={palette.emissive} />
      <directionalLight position={[0, 6, 3]} intensity={0.5} />
    </>
  );
}

/* ── Full scene ──────────────────────────────────────────────────────────── */

function Scene(props: Omit<MarketCoreProps, "height">) {
  return (
    <>
      <Lighting regime={props.regime} />
      <ParticleCloud
        regime={props.regime}
        breadth={props.breadth}
        volatility={props.volatility}
      />
      <CoreSphere {...props} />
      <OrbitControls
        enableZoom={false}
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.4}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={(2 * Math.PI) / 3}
      />
    </>
  );
}

/* ── Public component ────────────────────────────────────────────────────── */

export function MarketIntelligenceCore({
  regime    = "UNKNOWN",
  volatility = 0.3,
  breadth    = 0.5,
  vix        = 15,
  height     = 260,
}: Partial<MarketCoreProps>) {
  return (
    <div style={{ height, width: "100%" }} aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 3.6], fov: 45 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <Scene
          regime={regime}
          volatility={volatility}
          breadth={breadth}
          vix={vix}
        />
      </Canvas>
    </div>
  );
}

/* ── Regime label overlay ────────────────────────────────────────────────── */

const REGIME_LABEL: Record<MarketRegime, { text: string; cls: string }> = {
  BULL:     { text: "BULLISH",  cls: "text-[var(--color-bull)]" },
  BEAR:     { text: "BEARISH",  cls: "text-[var(--color-bear)]" },
  SIDEWAYS: { text: "SIDEWAYS", cls: "text-[var(--color-info)]" },
  UNKNOWN:  { text: "LOADING",  cls: "text-[var(--color-fg-subtle)]" },
};

interface CoreCardProps extends Partial<MarketCoreProps> {
  /** Extra bottom stats rendered below the sphere. */
  stats?: Array<{ label: string; value: string | number; positive?: boolean }>;
}

/**
 * CoreCard — the full card wrapper used in the dashboard.
 * Renders the 3D sphere + regime label + optional stat row.
 */
export function MarketCoreCard({
  regime    = "UNKNOWN",
  volatility = 0.3,
  breadth    = 0.5,
  vix        = 15,
  height     = 200,
  stats      = [],
}: CoreCardProps) {
  const label = REGIME_LABEL[regime];
  // At compact heights (≤140px) only show the orb + regime label inline,
  // skip the separator and stats row so nothing overflows.
  const compact = height <= 140;

  return (
    <div className="relative flex flex-col items-center justify-between glass rounded-2xl overflow-hidden p-3 h-full min-h-0">
      {/* 3D canvas — fills available width */}
      <div className="w-full flex-1 min-h-0">
        <MarketIntelligenceCore
          regime={regime}
          volatility={volatility}
          breadth={breadth}
          vix={vix}
          height={height}
        />
      </div>

      {/* Regime label */}
      <div className="mt-1 flex flex-col items-center gap-0.5">
        <span className={`text-[10px] font-bold uppercase tracking-[0.20em] ${label.cls}`}>
          {label.text}
        </span>
        {!compact && (
          <span className="text-[8px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            Market Regime
          </span>
        )}
      </div>

      {/* Stats row — only when not compact */}
      {!compact && stats.length > 0 && (
        <>
          <div className="mt-2 w-full separator-gradient mb-2" />
          <div className="flex w-full justify-around">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-0.5">
                <span
                  className={`text-xs font-bold num ${
                    s.positive === true
                      ? "text-[var(--color-bull)]"
                      : s.positive === false
                        ? "text-[var(--color-bear)]"
                        : "text-[var(--color-fg)]"
                  }`}
                >
                  {s.value}
                </span>
                <span className="text-[8px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
