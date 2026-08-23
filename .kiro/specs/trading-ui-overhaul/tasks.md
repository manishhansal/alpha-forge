# Implementation Plan: Trading UI Overhaul — Institutional Intelligence Terminal (IIT)

## Overview

This plan converts the IIT design into incremental coding tasks ordered by the 5-layer dependency model. Each task builds on the previous, ending with full page-level integration. No hanging code: every component is wired into a consuming page or layout before its parent task closes. The implementation language is **TypeScript** throughout, matching the existing codebase.

---

## Tasks

- [x] 1. Layer 1 — Design System Foundation
  - [x] 1.1 Extend `src/app/globals.css` with IIT token extensions
    - Add new semantic color tokens to the existing `@theme inline` block: `--color-panel-bg`, `--color-panel-border`, `--color-data-positive`, `--color-data-negative`, `--color-data-neutral`, `--color-ai-accent`, and `--color-regime-{bull,bear,sideways,highvol}`
    - Add light-mode (`:root`) and dark-mode (`.dark`) OKLCH variable values for every new token as specified in the design
    - Add `--radius-panel: 0.75rem` token
    - Add spacing scale `--space-1` through `--space-12` (0.25rem multiples)
    - Add font role variables: `--font-data`, `--font-label`, `--font-body`
    - Add `@keyframes`: `price-flash-up`, `price-flash-down`, `breakout-pulse`, `vix-warning-pulse`, `celebration-pulse`, `shimmer-border`
    - Add `data-density` utility classes: `[data-density="compact"]`, `[data-density="default"]`, `[data-density="comfortable"]`
    - Add aurora CSS variable `--aurora-regime-a` with a 1200ms CSS custom property transition on `.dark`
    - Add `prefers-reduced-motion` override block: `animation-duration: 0.01ms`, `transition-duration: 0.01ms`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 12.2, 12.3, 12.4, 12.7, 16.5_

  - [x] 1.2 Create `src/lib/motion-presets.ts`
    - Export `SPRING_FAST: Transition` (stiffness 600, damping 35)
    - Export `SPRING_DEFAULT: Transition` (stiffness 400, damping 28)
    - Export `SPRING_GENTLE: Transition` (stiffness 240, damping 24)
    - Export `SPRING_MICRO: Transition` (stiffness 800, damping 40)
    - Export `stagger(count: number, baseDelay = 0.04): Pick<MotionProps, "transition">` helper using `staggerChildren`
    - All exports are named (no default export)
    - _Requirements: 1.5, 17.6_

  - [ ]* 1.3 Write unit tests for `motion-presets.ts`
    - Verify all four Spring constants export with correct stiffness and damping values
    - Verify `stagger()` returns a `transition` object with `staggerChildren` equal to `baseDelay`
    - Verify `stagger()` default `baseDelay` is 0.04
    - File: `tests/lib/motion-presets.test.ts`
    - _Requirements: 1.5_

- [x] 2. Layer 2 — UIStore and RegimeContext
  - [x] 2.1 Create `src/store/uiStore.ts`
    - Follow the same `create<T>()` + `persist` pattern used in `src/store/india/marketStore.ts`
    - Define `UIState` interface with all six slices: `sidebarCollapsed`, `tableDensity`, `commandPaletteOpen`, `activeRegime`, `chartFullscreen`, `radarVisible`
    - Implement all actions: `toggleSidebar`, `setSidebarCollapsed`, `openCommandPalette`, `closeCommandPalette`, `setRegime`, `setDensity`, `setChartFullscreen`, `toggleRadar`
    - Use Zustand `persist` middleware with key `"af-ui"`, partializing to persist only `sidebarCollapsed` and `tableDensity`
    - Add `useEffect` in a companion `useBodyScrollLock` hook (inline or separate) to toggle `document.body.style.overflow` when `commandPaletteOpen` changes
    - Export `useUIStore` as the single named export
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6, 11.7_

  - [ ]* 2.2 Write unit tests for `uiStore`
    - Test `toggleSidebar` flips `sidebarCollapsed` on each call
    - Test `setDensity` stores the provided value
    - Test `setRegime` stores the provided `MarketRegime` value
    - Test `setChartFullscreen` and `toggleRadar` round-trip correctly
    - Test `openCommandPalette` / `closeCommandPalette` set `commandPaletteOpen` to `true` / `false`
    - **Property 8: UIStore action round-trip preserves state correctly**
    - **Validates: Requirements 11.2**
    - File: `tests/stores/uiStore.test.ts`
    - _Requirements: 11.1, 11.2_

  - [x] 2.3 Create `src/lib/regime-context.tsx`
    - Define `RegimeContextValue` interface: `{ regime: MarketRegime; isHighVol: boolean; vix: number | null }`
    - Export `RegimeContext` created with `React.createContext` (default: `UNKNOWN`, `false`, `null`)
    - Export `useRegime()` hook that reads from `RegimeContext`
    - Export `RegimeProvider` component that reads `activeRegime` from `useUIStore`, computes `isHighVol` (VIX > 25), and injects `--aurora-regime-a` as an inline CSS variable with a `display: contents` wrapper div
    - Implement aurora color mapping: BULL → green oklch, BEAR → red oklch, SIDEWAYS/UNKNOWN → neutral oklch
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.7_

  - [ ]* 2.4 Write unit tests for `RegimeContext`
    - Verify `useRegime()` returns default values when no provider is present
    - Verify `RegimeProvider` provides `regime` from `useUIStore`
    - Verify `isHighVol` is `true` when `vix > 25` and `false` when `vix <= 25`
    - Verify `isHighVol` uses the 3-point hysteresis (show at 25, hide at 22) — test at boundary values 22, 23, 25, 26
    - File: `tests/lib/regime-context.test.tsx`
    - _Requirements: 12.1, 12.6_

- [x] 3. Layer 3 — Trading Component Library (Core)
  - [x] 3.1 Create `src/components/trading/SignalBadge.tsx`
    - Implement `SignalBadge` with `action: "LONG" | "SHORT" | "BUY" | "SELL" | "WAIT"`, `size?: "sm" | "md" | "lg"`, `showIcon?: boolean`, `className?: string`
    - Color mapping: LONG/BUY → `var(--color-data-positive)`, SHORT/SELL → `var(--color-data-negative)`, WAIT → `var(--color-fg-muted)` — use only CSS variable tokens, never hardcoded hex/RGB
    - Export exactly one named export `SignalBadge` — no default export
    - _Requirements: 10.1, 1.7, 17.2_

  - [ ]* 3.2 Write property test for `SignalBadge`
    - **Property 1: SignalBadge renders the correct color token for every action**
    - **Validates: Requirements 1.7, 10.1**
    - Use `fast-check` to enumerate all five action values and assert color class/variable applied
    - Assert that no rendered element contains hardcoded hex or RGB color values
    - File: `tests/features/ui-overhaul/signal-badge.property.test.tsx`
    - _Requirements: 1.7, 10.1_

  - [x] 3.3 Create `src/components/trading/ConfidenceBar.tsx`
    - Implement `ConfidenceBar` with `value: number` (0–100), `showLabel?: boolean`, `height?: number` (px, default 6), `className?: string`
    - Fill uses `color-mix(in oklch, var(--data-positive) ${value}%, var(--data-neutral))` gradient
    - Fill element has `data-testid="confidence-bar-fill"` and `style={{ width: "${value}%" }}`
    - Export named `ConfidenceBar`
    - _Requirements: 10.2_

  - [ ]* 3.4 Write property test for `ConfidenceBar`
    - **Property 2: ConfidenceBar fill ratio is proportional to value**
    - **Validates: Requirements 10.2**
    - Use `fc.integer({ min: 0, max: 100 })` and assert `fill.style.width` matches `value` within 0.01%
    - File: `tests/features/ui-overhaul/confidence-bar.property.test.tsx`
    - _Requirements: 10.2_

  - [x] 3.5 Create `src/components/trading/RegimeBadge.tsx`
    - Implement `RegimeBadge` with `regime: "BULL" | "BEAR" | "SIDEWAYS" | "HIGH_VOL" | "UNKNOWN"`, `animate?: boolean` (default `true`), `className?: string`
    - Map regime to `--color-regime-*` token for background
    - Icons: TrendingUp (BULL), TrendingDown (BEAR), Minus (SIDEWAYS), AlertTriangle (HIGH_VOL), Circle (UNKNOWN) from `lucide-react`
    - Wrap in `motion.span` with `SPRING_MICRO` entrance animation when `animate` is true
    - Respect `prefers-reduced-motion` via `useReducedMotion()` from `framer-motion`
    - Export named `RegimeBadge`
    - _Requirements: 10.3, 12.8_

  - [ ]* 3.6 Write property test for `RegimeBadge`
    - **Property 3: RegimeBadge applies the correct regime color token**
    - **Validates: Requirements 10.3, 6.8, 2.6**
    - Use `fc.constantFrom("BULL", "BEAR", "SIDEWAYS", "HIGH_VOL", "UNKNOWN")` and assert correct `--color-regime-*` CSS variable is applied
    - File: `tests/features/ui-overhaul/regime-badge.property.test.tsx`
    - _Requirements: 10.3_

  - [x] 3.7 Create `src/components/trading/NumberMorph.tsx`
    - Implement `NumberMorph` with `value: number`, `prefix?: string`, `suffix?: string`, `decimals?: number` (default 2), `className?: string`, `duration?: number`
    - Export internal `durationFor(prev: number, next: number): number` function (for testability): `< 1% change → 120ms`, `1–10% → 240ms`, `> 10% → 360ms`, returns 240 when prev === 0
    - Implement animation via Framer Motion `useMotionValue` + `animate()` — respect `prefers-reduced-motion` by using `{ duration: 0 }` when reduced motion is active
    - Display element has `data-testid="number-morph-display"`
    - Export named `NumberMorph` and `durationFor`
    - _Requirements: 10.4, 16.4_

  - [ ]* 3.8 Write property tests for `NumberMorph`
    - **Property 4: NumberMorph eventually displays the target value**
    - **Validates: Requirements 10.4, 3.6, 7.7**
    - Use `fc.float({ min: -1e6, max: 1e6, noNaN: true })` and assert displayed text matches formatted target after animation
    - **Property 5: NumberMorph animation duration scales with change magnitude**
    - **Validates: Requirements 16.4**
    - Use `fc.float({ min: 1, max: 10000, noNaN: true })` for prev and next; assert `durationFor(prev, next)` returns 120, 240, or 360 per the thresholds
    - File: `tests/features/ui-overhaul/number-morph.property.test.tsx`
    - _Requirements: 10.4, 16.4_

  - [x] 3.9 Create `src/components/trading/StatGrid.tsx`
    - Implement `StatGrid` with `items: StatItem[]`, `cols: 2 | 3 | 4`, `className?: string`
    - `StatItem`: `{ label: string; value: string | number; positive?: boolean; className?: string }`
    - CSS grid: `grid-template-columns: repeat(${cols}, minmax(0, 1fr))`
    - Label uses `--font-label` (small, uppercase, tracked), value uses `--font-data` (tabular-nums)
    - Skeleton state when `loading` prop provided: render `<Skeleton>` cells matching dimensions
    - Export named `StatGrid`
    - _Requirements: 10.5_

  - [ ]* 3.10 Write property test for `StatGrid`
    - **Property 6: StatGrid renders all items in the correct column count**
    - **Validates: Requirements 10.5**
    - Use `fc.array(fc.record({...}))` with `fc.constantFrom(2, 3, 4)` for cols; assert `n` cells rendered in `grid-template-columns: repeat(c, ...)`
    - File: `tests/features/ui-overhaul/stat-grid.property.test.tsx`
    - _Requirements: 10.5_

  - [x] 3.11 Create `src/components/trading/PanelHeader.tsx`
    - Implement `PanelHeader` with `title: string`, `icon?: React.ReactNode`, `badge?: React.ReactNode`, `action?: React.ReactNode`, `className?: string`
    - Fixed 40px row height, flex row layout: icon + title on left, badge + action on right
    - Title: `text-sm font-semibold`
    - Export named `PanelHeader`
    - _Requirements: 10.6_

  - [x] 3.12 Create `src/components/trading/RiskMeter.tsx`
    - Implement `RiskMeter` with `value: number` (0–100), `orientation?: "horizontal" | "vertical"` (default `"horizontal"`), `showLabel?: boolean`, `className?: string`
    - Segmented bar: 3 segments — green (0–33) using `--color-data-positive`, yellow (33–66) using `--color-warning`, red (66–100) using `--color-data-negative`
    - Active segment indicated by `data-active-segment` attribute and class: `risk-segment-low`, `risk-segment-mid`, `risk-segment-high`
    - Export named `RiskMeter`
    - _Requirements: 10.7_

  - [ ]* 3.13 Write property test for `RiskMeter`
    - **Property 7: RiskMeter applies the correct segment color for every risk value**
    - **Validates: Requirements 10.7**
    - Use `fc.integer({ min: 0, max: 100 })` and assert `[data-active-segment]` has correct class (`risk-segment-low`, `risk-segment-mid`, `risk-segment-high`) for each value range
    - File: `tests/features/ui-overhaul/risk-meter.property.test.tsx`
    - _Requirements: 10.7_

  - [ ]* 3.14 Write unit tests for trading component library
    - Test `SignalBadge` renders correct label and icon for all five actions
    - Test `ConfidenceBar` renders at value=0, 50, 100 with correct fill ratios
    - Test `RegimeBadge` renders correct icon for each regime value
    - Test `StatGrid` renders correct number of cells for 6 items with `cols={3}`
    - Test `PanelHeader` renders title, icon slot, badge slot, and action slot
    - Test `RiskMeter` renders at 0, 33, 66, 100 with correct segment classes
    - Test `NumberMorph` renders formatted string `"42.50"` for `value={42.5}` after a tick
    - File: `tests/components/trading/trading-components.test.tsx`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

- [x] 4. Layer 3 — Layout Primitives
  - [x] 4.1 Create `src/components/layout/PageHeader.tsx`
    - Implement `PageHeader` with `title: string`, `subtitle?: string`, `regime?: RegimeLabel`, `action?: React.ReactNode`, `className?: string`
    - First child in a page; `mb-6` spacing, flex row
    - `<h1>` title: `text-xl font-semibold`; subtitle: `text-sm` fg-muted
    - When `regime` provided, render `<RegimeBadge>` inline with title
    - Export named `PageHeader`
    - _Requirements: 14.1, 14.2_

  - [x] 4.2 Create `src/components/layout/EmptyState.tsx`
    - Implement `EmptyState` with `icon: React.ComponentType<{ className?: string }>`, `heading: string`, `description?: string`, `action?: { label: string; onClick: () => void }`, `className?: string`
    - Centered layout
    - Export named `EmptyState`
    - _Requirements: 14.4_

  - [x] 4.3 Create `src/components/layout/ErrorState.tsx`
    - Implement `ErrorState` with `error: Error | string`, `onRetry?: () => void`, `className?: string`
    - Red-tinted icon; error message from `error.message || String(error)`; optional "Retry" button
    - Export named `ErrorState`
    - _Requirements: 14.5_

  - [x] 4.4 Create `src/components/layout/BentoGrid.tsx`
    - Implement `BentoGrid` with `children: React.ReactNode`, `cols?: number` (default 12), `gap?: string`, `className?: string`
    - CSS: `display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr))`
    - Implement `BentoCell` with `colSpan?: number` (1–12), `rowSpan?: number`, `children: React.ReactNode`, `className?: string`
    - Below `768px`: all cells collapse to `grid-column: span 12` via Tailwind responsive breakpoint
    - Export named `BentoGrid` and `BentoCell`
    - _Requirements: 5.1, 6.1, 14.1, 15.1_

  - [x] 4.5 Create `src/components/layout/PageTransition.tsx`
    - Implement `PageTransition` wrapping children in `<motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={SPRING_GENTLE}>`
    - Respect `prefers-reduced-motion` via `useReducedMotion()` — use `{ duration: 0 }` when active
    - Export named `PageTransition`
    - _Requirements: 14.8, 16.2, 16.6_

  - [ ]* 4.6 Write unit tests for layout primitives
    - Test `PageHeader` renders `<h1>` with title text; renders `RegimeBadge` when `regime` is provided
    - Test `EmptyState` renders heading, description, and action button
    - Test `ErrorState` renders error message from `Error` object; calls `onRetry` on button click
    - Test `BentoGrid` renders correct `grid-template-columns` style for default (12) and custom cols
    - Test `BentoCell` renders with correct `grid-column: span N` style
    - Test `PageTransition` renders children; uses zero-duration transition when `useReducedMotion` returns true
    - File: `tests/components/layout/layout-primitives.test.tsx`
    - _Requirements: 14.1, 14.2, 14.4, 14.5_

- [x] 5. Checkpoint — Foundation complete
  - Ensure all tests in `tests/lib/`, `tests/stores/`, `tests/components/trading/`, `tests/components/layout/`, and `tests/features/ui-overhaul/` pass. Ask the user if questions arise before proceeding to shell refactors.

- [x] 6. Layer 2 — Shell Refactor (Sidebar, Topbar, TickerBar)
  - [x] 6.1 Refactor `src/components/dashboard/sidebar.tsx`
    - Update collapsed/expanded widths to `56px` / `248px`; apply `SPRING_DEFAULT` transition via `animate={{ width: collapsed ? 56 : 248 }}`
    - Add `regime` prop and render 2px right-edge regime indicator strip colored from `--color-regime-*` tokens (India market only)
    - Replace `FooterCard` with `FooterDataStrip`: data source label, last-refresh timestamp, and connection quality dot (green/yellow/red)
    - Add `shimmer-border` keyframe animation to `SignInNudge` CTA for unauthenticated users
    - Split nav into two groups with `separator-gradient` divider between primary pages and analytics/tools
    - Add `onKeyDown` handler to `<nav>`: ArrowUp/ArrowDown cycles items, Enter navigates, Escape blurs
    - Add `useBreakpoint(1024)` hook auto-collapse: call `setSidebarCollapsed(true)` when below 1024px threshold
    - Integrate `useUIStore` for `sidebarCollapsed`/`setSidebarCollapsed`/`toggleSidebar`
    - Add `aria-label` to all nav items; floating tooltip within 120ms of hover
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 15.2_

  - [x] 6.2 Create `src/hooks/useBreakpoint.ts`
    - Implement `useBreakpoint(threshold: number): boolean` using `ResizeObserver` on `document.documentElement`
    - Returns `true` when `window.innerWidth < threshold`
    - SSR-safe: default to `false` when `window` is undefined
    - Export named `useBreakpoint`
    - _Requirements: 15.2_

  - [x] 6.3 Refactor `src/components/dashboard/topbar.tsx`
    - Add `TopbarBreadcrumb` sub-component deriving `Market · Section` from `usePathname()`
    - Refactor `ConnectionPill` to three-state machine: `connected`, `reconnecting`, `offline` with `SPRING_MICRO` transition
    - Refactor `ThemeToggle` to three-segment pill (Light · System · Dark) with `layoutId="theme-pill"` and `SPRING_FAST`
    - Add `CommandPalette` trigger chip with `⌘K` label and 8s interval pulse on the `K` character (guarded by `prefers-reduced-motion`)
    - Add `VixWarningChip` sub-component: reads `isHighVol` from `useRegime()`; shows/hides with `vix-warning-pulse` animation; uses `aria-live="polite"`
    - Add `aria-label` to all interactive elements; keep height at 52px
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 12.6_

  - [x] 6.4 Refactor `src/components/dashboard/market-ticker-bar.tsx`
    - Wrap price display in `<NumberMorph>` on each `TickerChip`
    - On price update: add `animate-price-flash-up` / `animate-price-flash-down` class (400ms CSS animation, `animation-fill-mode: forwards`)
    - Add India SENSEX chip alongside existing NIFTY/BANKNIFTY/FINNIFTY/VIX
    - Add Market Closed pill on the right edge, reading from the Best-Time engine
    - Below `640px`: render static 2-chip strip only (no scrolling ticker)
    - Keep `.ticker-scroll:hover { animation-play-state: paused }` behavior
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 15.3_

  - [x] 6.5 Wire `RegimeProvider` into `src/app/(dashboard)/layout.tsx`
    - Wrap the dashboard layout body in `<RegimeProvider>` with `vix` value sourced from `useIndiaMarketStore` snapshot
    - Add a `useEffect` in the layout (or in a client component child) that calls `useUIStore.setRegime()` when `useIndiaMarketStore` snapshot regime changes
    - _Requirements: 12.1, 11.5_

  - [ ]* 6.6 Write unit tests for shell components
    - Test `Sidebar` renders collapsed state (56px) and expanded state (248px)
    - Test `Sidebar` renders `FooterDataStrip` with data-source, timestamp, and connection-quality dot
    - Test `Topbar` renders `TopbarBreadcrumb` with correct `Market · Section` label for a mocked pathname
    - Test `VixWarningChip` renders when `isHighVol` is true and is absent when false
    - Test `useBreakpoint` returns `true` when `innerWidth < threshold`
    - File: `tests/components/shell-components.test.tsx`
    - _Requirements: 2.1, 2.7, 3.2, 3.6_

- [x] 7. Layer 3 — AiRadar Component
  - [x] 7.1 Create `src/components/trading/AiRadar.tsx`
    - Define `AiRadarRow` and `AiRadarProps` interfaces as specified in the design
    - Implement TanStack Table v9 with columns: `rank`, `stock` (symbol + `RegimeBadge`), `aiScore` (`ConfidenceBar`), `momentum` (60×24px inline SVG sparkline), `volume` (relative volume bar), `oi` (delta arrow + percentage), `regime` (`RegimeBadge`), `signal` (`SignalBadge`)
    - Support multi-column sorting (asc/desc/none) with spring-animated sort indicator
    - Search input above table filtering on `symbol` and `sector` (case-insensitive); animated row reorder via `AnimatePresence`
    - Implement `HoverDetailPanel` (280px wide, absolutely positioned): appears after 200ms hover delay; contains `ConfidenceBar` rows per confluence factor, win probability, entry/stop/TP1 grid, "View Signal" button; animates in with `SPRING_FAST`, out with `SPRING_MICRO`
    - Default to `data-density="compact"`; density toggle in toolbar writing to `useUIStore.setDensity()`
    - Keyboard nav: `Tab` → next row, `Enter` → expand detail panel inline, `Escape` → collapse
    - `tabIndex={0}` and `aria-label` on each row
    - Skeleton loading state when `loading={true}`
    - Export named `AiRadar`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ]* 7.2 Write property tests for `AiRadar`
    - **Property 10: AI Radar filter returns only matching rows**
    - **Validates: Requirements 8.3**
    - Use `fc.array(fc.record({ symbol: fc.string(), sector: fc.string(), ... }))` and `fc.string()`; type query into search input; assert every visible row's symbol or sector contains query (case-insensitive)
    - **Property 11: AI Radar sort is monotone for any sortable column**
    - **Validates: Requirements 8.2**
    - Use `fc.array(fc.record({ aiScore: fc.integer({ min: 0, max: 100 }), ... }))` and assert adjacent rows satisfy `row[i].value ≤ row[i+1].value` in ascending order
    - File: `tests/features/ui-overhaul/ai-radar.property.test.tsx`
    - _Requirements: 8.2, 8.3_

- [x] 8. Layer 5 — 3D Component Suite
  - [x] 8.1 Refactor `src/components/3d/market-intelligence-core.tsx` — add `quality` prop
    - Add `RenderQuality = "low" | "medium" | "high"` type
    - Add `quality?: RenderQuality` to `MarketCoreProps` (default `"medium"`)
    - Map quality to sphere geometry args: `low → [32,32]`, `medium → [64,64]`, `high → [128,128]`
    - Add `useReducedMotion()` from `framer-motion`; when true, set `useFrame` to no-op and `MeshDistortMaterial` `speed` to 0
    - _Requirements: 13.1, 13.2_

  - [x] 8.2 Refactor `src/components/3d/market-core-widget.tsx` — pass `quality` prop
    - Pass `quality` prop through `MarketCoreWidget` to `MarketIntelligenceCore`
    - Default `quality` based on `useBreakpoint(1024)`: mobile → `"low"`, desktop → `"medium"`
    - _Requirements: 13.1_

  - [ ]* 8.3 Write property test for `MarketIntelligenceCore` quality prop
    - **Property 13: MarketIntelligenceCore geometry segments match quality prop**
    - **Validates: Requirements 13.1**
    - For each of `"low"`, `"medium"`, `"high"`: render the component and assert the sphere geometry receives the correct `[widthSegments, heightSegments]` args
    - File: `tests/features/ui-overhaul/market-core-quality.property.test.tsx`
    - _Requirements: 13.1_

  - [x] 8.4 Create `src/components/3d/risk-sphere.tsx`
    - Implement `RiskSphere` with `riskLevel: number` (0–100), `size?: number` (default 120), `className?: string`
    - Color encoding: 0–33 → `oklch(0.76 0.20 155)` green, 33–66 → `oklch(0.80 0.18 78)` yellow, 66–100 → `oklch(0.68 0.24 22)` red
    - Scale: `0.7 + (riskLevel / 100) * 0.5`; opacity: `0.5 + (riskLevel / 100) * 0.4`
    - Use `MeshStandardMaterial` (no `MeshDistortMaterial`); simple Y-axis rotation via `useFrame`
    - Dynamically imported via `next/dynamic` with `ssr: false`; skeleton: pulsing circle at `size × size`
    - Clean up R3F renderer on unmount
    - Export named `RiskSphere`
    - _Requirements: 13.3, 13.4, 13.7, 13.8_

  - [ ]* 8.5 Write property test for `RiskSphere` color encoding
    - **Property 14: RiskSphere color encoding is monotone with risk level**
    - **Validates: Requirements 13.3**
    - Use `fc.integer({ min: 0, max: 100 })` and for two risk levels `a < b`; assert the OKLCH hue at `b` is ≤ hue at `a` (monotonically decreasing from green ~155° toward red ~22°)
    - File: `tests/features/ui-overhaul/risk-sphere.property.test.tsx`
    - _Requirements: 13.3_

  - [x] 8.6 Create `src/components/3d/portfolio-galaxy.tsx`
    - Define `GalaxyPosition` and `PortfolioGalaxyProps` interfaces as in the design
    - Implement R3F particle system using `Points` + `PointsMaterial` with `sizeAttenuation: true`
    - Particle size: `0.05 + position.size * 0.15`; color: P&L gradient from red at ≤ -50% to green at ≥ +50%
    - `useFrame`: slow Y-axis rotation at 0.001 rad/frame; mouse parallax via `useThree` camera lerp
    - Dynamically imported via `next/dynamic` with `ssr: false`; skeleton: pulsing circle matching `height`
    - Clean up R3F renderer on unmount
    - Export named `PortfolioGalaxy`
    - _Requirements: 13.5, 13.6, 13.7, 13.8_

- [x] 9. Layer 4 — Crypto Overview Page
  - [x] 9.1 Refactor `src/app/(dashboard)/page.tsx` (Crypto Overview) — BentoGrid layout
    - Replace existing layout with `<BentoGrid cols={12}>` structure:
      - `MarketCoreWidget`: `colSpan={4}` `rowSpan={2}` (top-left) with gradient border shifting hue by regime; `RegimeBadge` below canvas with `SPRING_DEFAULT` scale animation
      - BTC overview card: `colSpan={4}` `rowSpan={1}` (top-center); ETH: `colSpan={2}`; SOL: `colSpan={2}` (top-right); all using `<NumberMorph>` for live prices from `useMarketStore`
      - Sentiment card: `colSpan={4}` `rowSpan={1}` — redesigned with Fear & Greed arc gauge (SVG), funding rate (color-coded), OI trend arrow, L/S ratio bar
      - Quick Signals: `colSpan={4}` — 3-column signal grid; each cell with `SignalBadge`, symbol, confidence ring, one-line rationale; click → `AnimatePresence` expand in-place
      - Global stats strip: `colSpan={12}` — horizontal stat row
    - Wrap page content in `<PageTransition>` and `<PageHeader>`
    - Add `useEffect` syncing crypto regime to `useUIStore.setRegime()`
    - Add Best Time banner with `SPRING_GENTLE` entrance and background tint by score
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 14.1, 14.8_

- [x] 10. Layer 4 — India Overview Page
  - [x] 10.1 Refactor `src/app/(dashboard)/in/page.tsx` (India Overview) — BentoGrid layout
    - Replace layout with `<BentoGrid cols={12}>`:
      - `MarketCoreWidget`: `colSpan={4}` `rowSpan={3}` (top-left); entrance animate scale from 0.8 via `SPRING_GENTLE` after `IntersectionObserver` fires
      - NIFTY strip: `colSpan={5}` `rowSpan={1}` — index value `<NumberMorph>`, day change, percentage, 20-bar sparkline
      - BANKNIFTY strip: `colSpan={5}` `rowSpan={1}`
      - FINNIFTY strip: `colSpan={5}` `rowSpan={1}`
      - Top 5 Stocks: `colSpan={3}` `rowSpan={3}` — ranked cards with `SPRING_GENTLE` stagger; each with rank, symbol, sector badge, `SignalBadge`, price + change, score bar
      - MSB Signals TanStack Table: `colSpan={8}` — columns: Symbol, Signal Type, Strength bar (0–100), Entry, Stop, Time; `data-density="compact"`, `SPRING_MICRO` row entrance
      - Order Flow VPIN widget: `colSpan={4}` — gauge arc (0–1) + 20-bar sparkline using `--color-data-positive`/`--color-data-negative`
      - Range Expansion chips strip: `colSpan={12}` — horizontal scrollable; clicking a chip highlights MSB table row
    - Render `Regime_Reactive` banner strip (28px, full-width, below MarketTickerBar): regime label + context sentence, background from `--color-regime-*`
    - Wrap in `<PageTransition>` and `<PageHeader regime={activeRegime}>`
    - Add `useEffect` syncing India regime from `useIndiaMarketStore` to `useUIStore.setRegime()`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 14.1, 14.8_

- [x] 11. Layer 4 — AI Signals Page (Crypto)
  - [x] 11.1 Refactor `src/components/ai-signals/ai-signal-card.tsx`
    - Replace top accent line with 2px line using `var(--color-data-positive)` or `var(--color-data-negative)`
    - Replace confidence ring with animated fill arc: `SPRING_DEFAULT` on mount
    - Replace take-profit ladder with horizontal progress track visualization
    - Add hover expand (> 300ms): `AnimatePresence` vertical expand revealing SHAP factor breakdown (`signal.confluences`), mini payoff diagram if `signal.strike` exists, invalidation criteria; collapse on mouse-leave with `SPRING_FAST`
    - Apply `<NumberMorph>` to `confidenceScore` — animate from 0 to value on initial load, 50ms stagger between cards via `staggerChildren`
    - Add stale overlay: when `signal.timing.exitBy < Date.now()`, render frosted "Signal Expired" panel with "Refresh" button triggering TanStack Query `refetch()`
    - Respect `prefers-reduced-motion` for all animations
    - _Requirements: 7.3, 7.5, 7.6, 7.7, 16.8_

  - [ ]* 11.2 Write property tests for `AiSignalCard`
    - **Property 9: Stale signal overlay appears for all expired cards**
    - **Validates: Requirements 7.6**
    - Use `fc.integer()` to generate `exitBy` values both past and future; assert overlay is rendered when `exitBy < Date.now()` and absent otherwise
    - **Property 19: Stale signal overlay respects prefers-reduced-motion**
    - **Validates: Requirements 12.7, 16.6, 18.3, 18.4**
    - Mock `useReducedMotion()` returning `true`; assert no CSS animation or spring plays; color changes are immediate (0ms)
    - File: `tests/features/ui-overhaul/ai-signal-card.property.test.tsx`
    - _Requirements: 7.6, 12.7_

  - [x] 11.3 Refactor `src/components/ai-signals/ai-market-context-banner.tsx`
    - Redesign layout: regime classification (icon + label + confidence%) on left, 5-factor summary bar in center, regime-change timestamp on right
    - _Requirements: 7.1_

  - [x] 11.4 Refactor `src/app/(dashboard)/ai-signals/page.tsx`
    - Add `<PageHeader>` as first child
    - Apply masonry-like 2-column layout on `lg`, 1-column on mobile; WAIT signal cards at 60% height of active signals
    - Refactor direction/horizon filter strip as segmented control pill with `layoutId="signal-filter-pill"` and `SPRING_DEFAULT`; persist selection to localStorage
    - Wrap in `<PageTransition>`
    - _Requirements: 7.1, 7.2, 7.4, 14.1, 14.8_

- [x] 12. Layer 4 — India AI Signals Page and AiRadar Integration
  - [x] 12.1 Refactor India AI Signals page to integrate `AiRadar`
    - Locate `src/app/(dashboard)/in/ai-signals/page.tsx`
    - Add `<PageHeader regime={activeRegime}>` as first child
    - Wrap in `<PageTransition>`
    - Add "Show Radar" button below `<AiSignalsBoard>` that toggles `useUIStore.toggleRadar()`
    - Render `<AiRadar>` when `radarVisible` is true, sourcing data from the existing `/api/in/ai-signals` TanStack Query hook
    - Map API response to `AiRadarRow[]` format
    - _Requirements: 8.7, 14.1_

- [x] 13. Layer 4 — PriceChart Enhancements
  - [x] 13.1 Refactor `src/components/india/charts/price-chart.tsx`
    - Replace hardcoded colors with IIT tokens: background → `var(--color-bg)`, grid lines → `var(--color-panel-border)`, up candles → `var(--color-data-positive)`, down candles → `var(--color-data-negative)`
    - Add toolbar above chart: timeframe selector (1m, 5m, 15m, 1h, 1D) with `layoutId="chart-tf-pill"` and `SPRING_FAST`; indicator toggles (VWAP, EMA 9/21/50, Volume Profile, Signals); fullscreen button
    - When VWAP toggle active: overlay session/daily/weekly VWAP with distinct colors (`--color-brand`, `--color-info`, `--color-fg-muted`)
    - When Signals toggle active: render signal arrows via Lightweight Charts v5 marker API
    - Fullscreen mode: `useUIStore.setChartFullscreen(true)` + Framer Motion `layoutId` shared layout animation to fill viewport
    - Toolbar uses `data-density="compact"` row height
    - Ensure `chart.applyOptions()` is called on theme change — NOT chart recreation (property: single instance lifetime)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 13.2 Write property test for `PriceChart` instance stability
    - **Property 12: PriceChart preserves the chart instance across theme changes**
    - **Validates: Requirements 9.5**
    - Spy on `IChartApi.create()` or the relevant Lightweight Charts factory; simulate light → dark → light → dark theme changes via `useTheme`; assert `create()` called exactly once
    - File: `tests/features/ui-overhaul/price-chart.property.test.tsx`
    - _Requirements: 9.5_

- [x] 14. Layer 4 — Options Chain Page
  - [x] 14.1 Refactor `src/components/india/options/option-chain-table.tsx` — TanStack Table 12-column
    - Replace existing table implementation with TanStack Table v9
    - Implement 12-column layout: `ce_iv`, `ce_delta` (hidden by default), `ce_oi`, `ce_oiDelta`, `ce_ltp`, `strike`, `pe_ltp`, `pe_oiDelta`, `pe_oi`, `pe_delta` (hidden by default), `pe_iv`
    - Strike center column: ATM strike → `--color-brand/20` background, max-pain strike → `--color-warning/20` background, mutually exclusive
    - CE/PE IV columns: render `IvHeatDot` sub-component with `data-testid="iv-heat-dot"` — green class `iv-dot-green` if `iv < 20`, yellow `iv-dot-yellow` if `20 ≤ iv ≤ 40`, red `iv-dot-red` if `iv > 40`
    - LTP cells: wrap in `<NumberMorph>`; OI delta cells: arrow indicator (↑/↓/→)
    - Greeks toggle: reveal/hide `ce_delta` and `pe_delta` columns via `table.getColumn().toggleVisibility()` wrapped in `AnimatePresence`
    - PCR and Max Pain stats: render horizontal `StatGrid` strip above the table
    - Add tabbed interface: "Chain", "IV Surface", "GEX", "Payoff" tabs with `layoutId="options-tab-pill"` and `SPRING_FAST`
    - GEX Panel: collapsible section below the table (expanded by default); gamma flip level highlighted
    - `data-density="compact"` applied to table container
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

  - [ ]* 14.2 Write property tests for Options Chain
    - **Property 15: Options chain IV heat dot color threshold is consistent**
    - **Validates: Requirements 20.3**
    - Use `fc.float({ min: 0, max: 100, noNaN: true })` and assert `IvHeatDot` renders correct class at all values; test boundary: iv=19.9 → green, iv=20.1 → yellow
    - **Property 16: Options chain strike background encodes max-pain proximity**
    - **Validates: Requirements 20.2**
    - Use `fc.array(fc.record({ strike: fc.integer(), isAtm: fc.boolean(), isMaxPain: fc.boolean() }))` constrained so no row is both ATM and max-pain; assert mutually exclusive background application
    - File: `tests/features/ui-overhaul/options-chain.property.test.tsx`
    - _Requirements: 20.2, 20.3_

- [x] 15. Layer 4 — Daily Picks Page
  - [x] 15.1 Refactor `src/components/india/daily-picks/daily-pick-card.tsx`
    - Display: rank badge, symbol (`font-data`), signal direction icon (▲▼), entry/stop/target in 3-cell `StatGrid`, P&L via `<NumberMorph>` (polling every 30s from existing hook), status badge (OPEN/TARGET_HIT/STOP_HIT/CLOSED), progress bar toward target
    - `TARGET_HIT` state: 800ms `celebration-pulse` keyframe animation (border glow + scale); guarded by `prefers-reduced-motion`
    - `STOP_HIT` state: 500ms red flash via `vix-warning-pulse` animation; guarded by `prefers-reduced-motion`
    - All required fields always visible without interaction
    - _Requirements: 18.2, 18.3, 18.4_

  - [ ]* 15.2 Write property tests for `DailyPickCard`
    - **Property 18: Daily Picks card renders all required fields for any pick**
    - **Validates: Requirements 18.2**
    - Use `fc.record({ rank: fc.integer(), symbol: fc.string(), signal: ..., entry: fc.float(), stop: fc.float(), tp1: fc.float(), pnlPct: fc.float(), status: fc.constantFrom(...) })` and assert all 9 required fields are visible in the DOM without triggering any interaction
    - File: `tests/features/ui-overhaul/daily-pick-card.property.test.tsx`
    - _Requirements: 18.2_

  - [x] 15.3 Refactor `src/components/india/daily-picks/daily-picks-board.tsx`
    - Render each bucket (Indices Scalping, Opening Breakout, etc.) as a distinct horizontal section with `<PanelHeader>` and horizontal scroll grid on mobile
    - _Requirements: 18.1_

  - [x] 15.4 Refactor `src/components/india/daily-picks/expiry-trades-section.tsx`
    - Add prominent `Regime_Reactive` header with expiry countdown timer using `<NumberMorph>` updating every second
    - _Requirements: 18.5_

  - [x] 15.5 Refactor `src/components/india/daily-picks/daily-picks-history.tsx`
    - Replace current implementation with TanStack Table: Date, Bucket, Symbol, Entry, Target, Stop, Exit, P&L%, Status, Duration — sortable headers, client-side filtering by bucket and status
    - _Requirements: 18.6_

  - [x] 15.6 Refactor FnO Trend sections to collapsible panels
    - Wrap `src/components/india/daily-picks/fno-bullish-trend-section.tsx` in `<details>`/`<summary>` with animated chevron icon; collapsed by default
    - Wrap `src/components/india/daily-picks/fno-bearish-trend-section.tsx` in same pattern
    - _Requirements: 18.7_

  - [x] 15.7 Refactor `src/app/(dashboard)/in/daily-picks/page.tsx`
    - Add `<PageHeader>` as first child; wrap in `<PageTransition>`
    - _Requirements: 14.1, 14.8_

- [x] 16. Layer 4 — Paper Trading Page
  - [x] 16.1 Refactor `src/components/india/paper-trading/open-positions-card.tsx`
    - Implement TanStack Table with columns: Strategy (badge), Symbol, Direction, Entry, Mark Price (`NumberMorph`), P&L% (color-coded `NumberMorph`), P&L$, Duration, Actions (Close button)
    - Rows with P&L% ≥ +5%: add CSS class `row-positive-border` (2px left border `--color-data-positive`) via TanStack Table `meta` API
    - Rows with P&L% ≤ -3%: add class `row-negative-border` (2px left border `--color-data-negative`)
    - _Requirements: 19.1, 19.5, 19.6_

  - [ ]* 16.2 Write property tests for `PaperTradeRow`
    - **Property 17: Paper trade row border reflects P&L threshold**
    - **Validates: Requirements 19.5, 19.6**
    - Use `fc.float({ min: -100, max: 100, noNaN: true })` and assert row has `row-positive-border` when `pnlPct >= 5.0`, `row-negative-border` when `pnlPct <= -3.0`, neither when in `(-3.0, 5.0)`
    - File: `tests/features/ui-overhaul/paper-trade-row.property.test.tsx`
    - _Requirements: 19.5, 19.6_

  - [x] 16.3 Refactor `src/components/india/paper-trading/stats-panel.tsx`
    - Use `BentoGrid` sub-layout (4 columns): total P&L (large `NumberMorph`, 2 cols), win rate arc gauge (1 col), `RiskSphere` at 120×120px (1 col)
    - _Requirements: 19.2, 13.4_

  - [x] 16.4 Refactor `src/components/india/paper-trading/journal-card.tsx`
    - Apply `data-density="compact"` with TanStack Table: sortable Date, Symbol, Strategy, Entry, Exit, P&L%, Status, Notes columns
    - _Requirements: 19.3_

  - [x] 16.5 Refactor performance breakdown in paper trading
    - Locate performance breakdown section in paper trading page/components
    - Render per-strategy cumulative P&L chart using `lightweight-charts` line series (not Recharts)
    - _Requirements: 19.4_

  - [x] 16.6 Add double-confirm to "Close All Positions" button
    - First click: show confirmation `Tooltip` using the existing Radix `Tooltip` primitive
    - Second click within 3 seconds: execute the close-all action
    - _Requirements: 19.7_

  - [x] 16.7 Refactor `src/app/(dashboard)/in/paper-trading/page.tsx`
    - Add `<PageHeader>` as first child; wrap in `<PageTransition>`
    - _Requirements: 14.1, 14.8_

- [x] 17. Checkpoint — All page redesigns complete
  - Ensure all tests pass across `tests/components/`, `tests/features/ui-overhaul/`, and `tests/pages/`. Verify no import errors from directory restructuring. Ask the user if questions arise before proceeding.

- [ ] 18. Layer 6 — Remaining Property-Based Tests
  - [ ]* 18.1 Write remaining property tests (batch)
    - **Property 8 (UIStore round-trip)**: Use `fc.constantFrom("toggleSidebar", "setDensity", "setRegime", "setChartFullscreen", "toggleRadar")` and assert read-after-write correctness for each action — file: `tests/features/ui-overhaul/uistore.property.test.tsx`
    - **Validates: Requirements 11.2**
    - _Requirements: 11.2_

- [x] 19. Integration and import cleanup
  - [x] 19.1 Update all import paths for moved/created components
    - Audit all files importing from `src/components/dashboard/`, `src/components/ai-signals/`, `src/components/india/` that reference components that have been moved or renamed during refactoring
    - Run `npm run typecheck` to surface any broken imports and fix them
    - Ensure `src/components/trading/`, `src/components/layout/` directory exports are accessible via correct import paths
    - _Requirements: 17.1, 17.5_

  - [x] 19.2 Add integration smoke tests for all refactored pages
    - For each refactored page (Crypto Overview, India Overview, AI Signals, India AI Signals, Options Chain, Daily Picks, Paper Trading), render with mocked stores and assert `PageHeader` is the first meaningful child
    - File: `tests/pages/trading-ui-overhaul/page-smoke.test.tsx`
    - _Requirements: 14.1_

  - [ ]* 19.3 Write accessibility tests using `jest-axe`
    - Run `jest-axe` on all new components: `SignalBadge`, `ConfidenceBar`, `RegimeBadge`, `NumberMorph`, `StatGrid`, `PanelHeader`, `RiskMeter`, `PageHeader`, `EmptyState`, `ErrorState`, `BentoGrid`, `AiRadar`
    - Assert no axe violations at AA level
    - File: `tests/components/accessibility.test.tsx`
    - _Requirements: 15.7, 5.7_

- [x] 20. Final checkpoint
  - Run `npm test` to ensure all tests pass. Run `npm run typecheck` to confirm zero TypeScript errors. Ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP delivery
- Each task references specific requirements for full traceability
- The 5-layer architecture ensures no circular dependencies: Layer 1 → Layer 2/3 → Layer 4/5 → Layer 6
- All component files use named exports only (no default exports in component files)
- All color values in component files use `var(--color-*)` CSS variables — never hardcoded hex or RGB
- Property tests use `fast-check` (already a transitive dependency via the test stack; install with `npm install --save-dev fast-check` if not present)
- 3D components (`RiskSphere`, `PortfolioGalaxy`) use `next/dynamic` with `ssr: false` — no SSR import chain issues
- The `prefers-reduced-motion` guard is applied at every animation site via `useReducedMotion()` from `framer-motion`
- Checkpoints at tasks 5, 17, and 20 ensure incremental validation before proceeding to dependent work

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "2.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1", "3.3", "3.5", "3.7", "3.9", "3.11", "3.12", "4.1", "4.2", "4.3", "4.4", "4.5"] },
    { "id": 3, "tasks": ["3.2", "3.4", "3.6", "3.8", "3.10", "3.13", "4.6", "6.2"] },
    { "id": 4, "tasks": ["3.14", "6.1", "6.3", "6.4", "7.1", "8.1", "8.4", "8.6"] },
    { "id": 5, "tasks": ["6.5", "6.6", "7.2", "8.2", "8.3", "8.5"] },
    { "id": 6, "tasks": ["9.1", "10.1", "11.1", "11.3", "13.1", "14.1", "15.1", "15.3", "15.4", "15.5", "15.6", "16.1", "16.3", "16.4", "16.5", "16.6"] },
    { "id": 7, "tasks": ["11.2", "11.4", "12.1", "13.2", "14.2", "15.2", "15.7", "16.2", "16.7"] },
    { "id": 8, "tasks": ["18.1", "19.1"] },
    { "id": 9, "tasks": ["19.2", "19.3"] }
  ]
}
```
