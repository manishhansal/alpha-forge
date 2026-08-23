"use client";

/**
 * RiskSphereScene
 *
 * The actual React Three Fiber scene for the RiskSphere component.
 * Kept in a separate file so next/dynamic in risk-sphere.tsx can
 * code-split Three.js out of the initial bundle.
 *
 * Visual encoding:
 *   color   → risk tier (green 0-33, yellow 33-66, red 66-100)
 *   scale   → 0.7 + (riskLevel / 100) * 0.5
 *   opacity → 0.5 + (riskLevel / 100) * 0.4
 */

import * as React from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/* ── Colour helper ───────────────────────────────────────────────────────── */

function getRiskColor(riskLevel: number): string {
  if (riskLevel <= 33) return "#10d079"; // green
  if (riskLevel <= 66) return "#f59e0b"; // yellow
  return "#f43f5e";                       // red
}

/* ── Sphere mesh ─────────────────────────────────────────────────────────── */

interface SphereProps {
  riskLevel: number;
}

function Sphere({ riskLevel }: SphereProps) {
  const meshRef = React.useRef<THREE.Mesh>(null!);
  const color   = getRiskColor(riskLevel);
  const scale   = 0.7 + (riskLevel / 100) * 0.5;
  const opacity = 0.5 + (riskLevel / 100) * 0.4;

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.8;
      meshRef.current.rotation.x += delta * 0.2;
    }
  });

  return (
    <>
      {/* Ambient glow shell — BackSide so it blooms outward */}
      <mesh scale={scale * 1.3}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.05}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Main sphere — MeshStandardMaterial for GPU efficiency */}
      <mesh ref={meshRef} scale={scale}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.2}
          transparent
          opacity={opacity}
          roughness={0.3}
          metalness={0.4}
        />
      </mesh>
    </>
  );
}

/* ── Public scene component ──────────────────────────────────────────────── */

export interface RiskSphereSceneProps {
  riskLevel: number;
  size?: number;
}

export function RiskSphereScene({ riskLevel, size = 120 }: RiskSphereSceneProps) {
  return (
    <div style={{ width: size, height: size }} aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 3], fov: 45 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.4} />
        <pointLight position={[3, 3, 3]} intensity={2} color={getRiskColor(riskLevel)} />
        <pointLight position={[-2, -2, -2]} intensity={0.6} />
        <Sphere riskLevel={riskLevel} />
      </Canvas>
    </div>
  );
}
