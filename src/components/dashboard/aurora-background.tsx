"use client";

/**
 * AuroraBackground
 *
 * Renders the subtle animated mesh-gradient aurora layer behind the
 * dashboard content. Uses only CSS animations (no canvas, no JS frame loop)
 * so it has near-zero runtime cost and degrades gracefully when
 * prefers-reduced-motion is set.
 *
 * The component is intentionally position:fixed so it covers the full
 * viewport regardless of scroll. It sits at z-index 0 and every content
 * layer is above it. In light mode the aurora nodes are set to 0% opacity
 * via CSS variables so nothing changes visually.
 */

export function AuroraBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{ contain: "strict" }}
    >
      {/* Node A — top-left cyan/teal blob */}
      <div
        className="absolute rounded-full"
        style={{
          width: "70vw",
          height: "70vw",
          top: "-20vw",
          left: "-15vw",
          background:
            "radial-gradient(circle, var(--aurora-a) 0%, transparent 70%)",
          filter: "blur(60px)",
          animation: "aurora-drift-a 22s ease-in-out infinite",
          willChange: "transform",
        }}
      />

      {/* Node B — bottom-right violet/indigo blob */}
      <div
        className="absolute rounded-full"
        style={{
          width: "60vw",
          height: "60vw",
          bottom: "-10vw",
          right: "-10vw",
          background:
            "radial-gradient(circle, var(--aurora-b) 0%, transparent 70%)",
          filter: "blur(70px)",
          animation: "aurora-drift-b 28s ease-in-out infinite",
          willChange: "transform",
        }}
      />

      {/* Node C — center-right emerald/brand blob */}
      <div
        className="absolute rounded-full"
        style={{
          width: "50vw",
          height: "50vw",
          top: "30vh",
          right: "10vw",
          background:
            "radial-gradient(circle, var(--aurora-c) 0%, transparent 70%)",
          filter: "blur(80px)",
          animation: "aurora-drift-a 34s ease-in-out infinite reverse",
          willChange: "transform",
        }}
      />

      {/* Noise texture overlay for depth — very subtle */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }}
      />
    </div>
  );
}
