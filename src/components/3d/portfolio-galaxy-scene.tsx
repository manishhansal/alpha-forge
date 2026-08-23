"use client";

import * as React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface GalaxyPosition {
  symbol: string;
  size: number;      // normalized position size 0–1
  pnlPct: number;    // P&L percentage — negative = red, positive = green
}

function pnlToColor(pnlPct: number): THREE.Color {
  // Clamp to [-50, +50] range
  const t = Math.max(-50, Math.min(50, pnlPct));
  if (t >= 0) {
    // 0 → neutral gray, +50 → green
    const green = new THREE.Color("#10d079");
    const neutral = new THREE.Color("#64748b");
    return neutral.lerp(green, t / 50);
  } else {
    // 0 → neutral gray, -50 → red
    const red = new THREE.Color("#f43f5e");
    const neutral = new THREE.Color("#64748b");
    return neutral.lerp(red, Math.abs(t) / 50);
  }
}

interface ParticleSystemProps {
  positions: GalaxyPosition[];
}

function ParticleSystem({ positions }: ParticleSystemProps) {
  const pointsRef = React.useRef<THREE.Points>(null!);
  const { mouse } = useThree();

  // Generate stable particle positions on a sphere surface
  const geometry = React.useMemo(() => {
    if (positions.length === 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute([], 3));
      return geo;
    }

    const posArray = new Float32Array(positions.length * 3);
    const colArray = new Float32Array(positions.length * 3);

    positions.forEach((pos, i) => {
      // Fibonacci sphere distribution for even spacing
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const theta = goldenAngle * i;
      const y = 1 - (i / (positions.length - 1)) * 2;
      const radius = Math.sqrt(1 - y * y) * 2.0;

      // Slight random offset for organic feel
      const jitter = pos.size * 0.3 + 0.1;
      posArray[i * 3]     = radius * Math.cos(theta) + (Math.random() - 0.5) * jitter;
      posArray[i * 3 + 1] = y * 2.0 + (Math.random() - 0.5) * jitter;
      posArray[i * 3 + 2] = radius * Math.sin(theta) + (Math.random() - 0.5) * jitter;

      const color = pnlToColor(pos.pnlPct);
      colArray[i * 3]     = color.r;
      colArray[i * 3 + 1] = color.g;
      colArray[i * 3 + 2] = color.b;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(posArray, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colArray, 3));
    return geo;
  }, [positions]);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    // Slow Y-axis rotation
    pointsRef.current.rotation.y += delta * 0.001;
    // Mouse parallax — subtle camera position lerp via group rotation
    pointsRef.current.rotation.x = THREE.MathUtils.lerp(
      pointsRef.current.rotation.x,
      mouse.y * 0.1,
      0.05,
    );
  });

  if (positions.length === 0) {
    return null;
  }

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        vertexColors
        sizeAttenuation
        size={0.12}
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </points>
  );
}

export interface PortfolioGalaxySceneProps {
  positions: GalaxyPosition[];
  height?: number;
}

export function PortfolioGalaxyScene({ positions, height = 400 }: PortfolioGalaxySceneProps) {
  return (
    <div style={{ width: "100%", height }} aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.5} />
        <ParticleSystem positions={positions} />
      </Canvas>
    </div>
  );
}
