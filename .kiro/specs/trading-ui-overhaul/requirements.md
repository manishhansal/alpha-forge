# Requirements Document

## Introduction

AlphaForge is a professional multi-market trading terminal covering Crypto (BTC/ETH/SOL via Delta Exchange India / Binance) and Indian NSE F&O. The platform already ships a rich feature set — AI signals, paper trading, ML decision engine, options analytics, 3D market core, and a full sidebar navigation — but the visual design and component architecture are inconsistent, improvised, and fragmented. Many pages still use raw placeholder cards or design patterns that evolved organically rather than intentionally.

This feature specifies a complete, opinionated **UI overhaul** for every page and shell component of the dashboard. The design language is called **Institutional Intelligence Terminal (IIT)**: a precision-first, data-dense aesthetic designed to feel like a bespoke Bloomberg-meets-Figma interface — not a generic dark dashboard, not neon-everywhere, not glassmorphism soup. The overhaul is purely frontend — no new API routes, no logic changes — and must preserve all existing data flows, Zustand stores, TanStack Query hooks, and backend contracts.

**Existing tech stack (already installed, must be used):**
- Next.js 16 App Router · React 19 · TypeScript
- Tailwind CSS v4 (OKLCH palette, `@theme inline`, `.dark` class)
- Framer Motion (already `framer-motion@12`, labelled `motion` in docs)
- React Three Fiber + Three.js + Drei (already installed)
- Lightweight Charts v5 (chart plugin API available)
- TanStack Table v9
- Zustand v5
- Lucide React
- shadcn/ui primitives (Button, Card, Dialog, Tooltip — code owned in `src/components/ui/`)
- Sonner, cmdk (already installed)

---

## Glossary

- **IIT**: Institutional Intelligence Terminal — the design language name for this overhaul.
- **Design_System**: The unified set of CSS tokens, Tailwind utilities, spacing rules, and component patterns defined in this spec.
- **Shell**: The persistent layout wrapper: Sidebar + Topbar + MarketTickerBar + AuroraBackground.
- **Sidebar**: The collapsible left navigation panel (`src/components/dashboard/sidebar.tsx`).
- **Topbar**: The sticky top bar containing search, status pill, theme toggle, notifications, and user menu.
- **MarketTickerBar**: The real-time price ribbon below the Topbar.
- **Bento_Grid**: A dense, unequal-column responsive grid layout used on Overview pages — inspired by bento box design.
- **Panel**: A card-like surface component that forms the atomic unit of dashboard layouts. Higher density than a `Card`.
- **Signal_Card**: The component that renders a single AI signal (already exists as `AiSignalCard` — to be refactored into the new design system).
- **Market_Core**: The 3D sphere visualization representing market regime (already exists as `MarketIntelligenceCore`).
- **AI_Radar**: The AI Stock Radar table using TanStack Table with hover detail panels.
- **Motion_System**: The unified animation system covering micro-interactions, spring transitions, and number morphing.
- **Color_Token**: A named CSS variable in the `@theme inline` block (e.g. `--color-brand`, `--color-bull`).
- **Glow_Accent**: The single AI/brand accent color used for important system communications only — not decorative neon.
- **Regime_Reactive**: The property of a UI element that changes its visual state in response to the current market regime (BULL / BEAR / SIDEWAYS / HIGH_VOL).
- **Number_Morph**: An animated number transition that smoothly interpolates between two numeric values using Framer Motion's `animate` or a dedicated number-morphing hook.
- **Zustand_Store**: A Zustand v5 store. The existing stores (marketStore, india/marketStore, etc.) must not be broken; new stores follow the same naming convention.
- **TanStack_Table**: `@tanstack/react-table` v9 — the table primitive for AI Radar and all data-dense tables.
- **Hover_Detail_Panel**: A panel that appears on row hover in the AI Radar table, showing model confidence, SHAP factors, and per-signal details without navigating away.
- **Spring_Animation**: A physics-based animation using Framer Motion's spring presets rather than linear/ease curves — used for all interactive state transitions.
- **R3F**: React Three Fiber — the declarative Three.js renderer already in the codebase.
- **Lightweight_Charts**: The `lightweight-charts` v5 charting library already used for price charts, candlestick, volume, VWAP, and EMA overlays.
- **CommandPalette**: The cmdk-based command palette (`src/components/dashboard/command-palette.tsx`) for quick navigation.
- **Theme_Provider**: The existing `<ThemeProvider>` in `src/components/theme-provider.tsx` that drives light/dark/system switching.
- **OKLCH**: The perceptually-uniform color space used for all color tokens throughout the design system.

---

## Requirements

### Requirement 1: Design System Foundation

**User Story:** As a developer, I want a single authoritative design system (tokens, spacing, typography, motion presets) so that every component built during the overhaul shares a consistent visual language without per-component style decisions.

#### Acceptance Criteria

1. THE Design_System SHALL define all color tokens exclusively in OKLCH via the existing `globals.css` `@theme inline` block — no hardcoded hex or RGB values in component files.
2. THE Design_System SHALL extend the existing dark/light palette with the following new semantic tokens: `--color-panel-bg` (slightly elevated from `--surface`), `--color-panel-border` (finer than `--border`), `--color-data-positive`, `--color-data-negative`, `--color-data-neutral`, `--color-ai-accent` (the single Glow_Accent used only for AI communications), and `--color-regime-{bull,bear,sideways,highvol}`.
3. THE Design_System SHALL define a spacing scale using Tailwind v4 CSS variables: `--space-1` through `--space-12` mapping to `0.25rem` multiples — consistent with Tailwind's default scale but overridable per-token.
4. THE Design_System SHALL define three typographic roles: `--font-data` (tabular-nums, monospace — for prices and numbers), `--font-label` (small, uppercase, tracked — for axis labels and stat keys), and `--font-body` (sans-serif — inheriting `--font-sans`).
5. THE Motion_System SHALL define four named Spring presets as JavaScript constants in `src/lib/motion-presets.ts`: `SPRING_FAST` (stiffness 600, damping 35), `SPRING_DEFAULT` (stiffness 400, damping 28), `SPRING_GENTLE` (stiffness 240, damping 24), and `SPRING_MICRO` (stiffness 800, damping 40) — all used exclusively via Framer Motion.
6. THE Design_System SHALL define a `--radius-panel` token set to `0.75rem` as the canonical border-radius for Panel components, distinct from `--radius-xl` used on cards.
7. WHEN a new component file is created, THE component SHALL import color tokens via `var(--color-*)` CSS variables only — never via Tailwind color utilities that reference non-token values.
8. THE Design_System SHALL define a `data-density` attribute pattern: `data-density="compact"` (32px row height), `data-density="default"` (40px), `data-density="comfortable"` (48px) — readable by components to adjust internal spacing without prop drilling.

---

### Requirement 2: Shell Refactor — Sidebar

**User Story:** As a trader, I want a sidebar that feels like a precision instrument panel — not a generic nav menu — so that navigation is fast and the identity of the platform is clear.

#### Acceptance Criteria

1. THE Sidebar SHALL collapse to a 56px icon-only rail and expand to a 248px labeled view, animated with `SPRING_DEFAULT` (from the Motion_System).
2. WHEN the Sidebar is collapsed, THE Sidebar SHALL display icon-only navigation with a floating tooltip that appears within 120ms of hover — no delay.
3. THE Sidebar SHALL render the brand logo as an animated SVG mark (the existing `Activity` Lucide icon is a placeholder — the refactored version SHALL use a custom SVG path representing the TITAN AI identity) enclosed in a gradient container using `--color-brand` and `--color-ai-accent`.
4. THE Sidebar SHALL render the active navigation item with a 3px left-edge accent bar animated via Framer Motion `layoutId="sidebar-pill"` so the indicator slides between items with a spring transition.
5. THE Sidebar SHALL render navigation items in two visually distinct groups separated by a `separator-gradient` divider: (a) primary market pages and (b) analytics/tools pages — the grouping applies to both `CRYPTO_NAV` and `INDIA_NAV`.
6. WHEN the market is `india`, THE Sidebar SHALL render a subtle green-tinted regime indicator strip (2px wide, full height) on the right edge of the sidebar when the market regime is BULL, red when BEAR, and neutral otherwise — reading from the Zustand `useIndiaMarketStore`.
7. THE Sidebar footer card SHALL be replaced with a compact data strip showing: active data source label, last-refresh timestamp, and a live connection quality dot (green/yellow/red) — replacing the current static footer text.
8. THE Sidebar SHALL support keyboard navigation: `ArrowUp`/`ArrowDown` to move between items, `Enter` to navigate, `Escape` to close tooltips — meeting WCAG 2.1 AA keyboard accessibility.
9. WHEN `isAuthed` is false, THE Sidebar SHALL render a `Sign in to unlock` call-to-action with an animated shimmer effect on the border — not a plain dashed border.

---

### Requirement 3: Shell Refactor — Topbar

**User Story:** As a trader, I want a topbar that surfaces the most critical real-time system signals (connection, market phase, alerts) at a glance without distracting from the content below.

#### Acceptance Criteria

1. THE Topbar SHALL have a height of exactly 52px, a `backdrop-blur-xl` frosted background using `--color-bg/85`, and a 1px bottom border using `--color-panel-border`.
2. THE Topbar SHALL render a breadcrumb-style page context indicator on the left side: `Market > Section` (e.g., "India · AI Signals") — derived from the active pathname, updated via `usePathname()`.
3. THE Topbar SHALL render the `ConnectionPill` with three states: `connected` (green dot, "Live"), `reconnecting` (yellow dot + spinner, "Reconnecting"), and `offline` (red dot, "Offline") — with a `SPRING_MICRO` transition between states.
4. THE Topbar's `ThemeToggle` SHALL render as a three-segment pill (Light · System · Dark) with a sliding indicator using `layoutId="theme-pill"` and `SPRING_FAST` animation.
5. THE `CommandPalette` trigger in the Topbar SHALL render as a search chip showing the keyboard shortcut `⌘K` with a subtle animated pulse on the `K` character every 8 seconds to nudge discoverability — the pulse MUST respect `prefers-reduced-motion`.
6. WHEN the user has unread notifications, THE `NotificationsBell` icon SHALL animate with a `SPRING_MICRO` bounce and render an unread count badge — the badge count SHALL use Number_Morph animation when the count changes.
7. THE Topbar SHALL be accessible: all interactive elements SHALL have `aria-label` attributes, and the notification bell SHALL use `aria-live="polite"` to announce count changes to screen readers.

---

### Requirement 4: Shell Refactor — MarketTickerBar

**User Story:** As a trader, I want the ticker bar to be a precision instrument — not a scrolling mess — that lets me read any price at a glance and understand market direction immediately.

#### Acceptance Criteria

1. THE MarketTickerBar SHALL render as a 36px-tall strip below the Topbar with a frosted `bg-[var(--color-bg-elevated)]/60` background and a 1px bottom border.
2. THE MarketTickerBar SHALL render each ticker chip with: a live status dot (color matches the coin/index token color), the symbol label, a live price rendered with Number_Morph, and the 24h change percent.
3. WHEN a price updates, THE ticker chip SHALL flash the background — green flash for price-up, red flash for price-down — using a 400ms CSS animation that fades to transparent, NOT a persistent background color.
4. THE Crypto ticker bar SHALL pause auto-scroll when the user hovers over any chip and SHALL resume immediately on mouse-leave.
5. THE India ticker bar SHALL render NIFTY 50, BANKNIFTY, FINNIFTY, India VIX, and SENSEX chips — sourced from the existing `useIndiaMarketStore` snapshot.
6. WHEN the market session is closed (outside NSE 09:15–15:30 IST for India, or the worst trading zone for Crypto), THE MarketTickerBar SHALL render a subtle "Market Closed" pill on the right edge — using the existing Best-Time engine to determine session state.

---

### Requirement 5: Crypto Overview Page Redesign

**User Story:** As a crypto trader, I want the overview page to be a Bento_Grid command center that gives me regime, prices, sentiment, and signals in one view — not a linear list of cards.

#### Acceptance Criteria

1. THE Crypto Overview page SHALL use a `Bento_Grid` layout with a 12-column CSS grid: the Market_Core 3D widget occupies 4 columns × 2 rows (top-left), the BTC overview card occupies 4 columns × 1 row (top-center), ETH and SOL each occupy 2 columns × 1 row (top-right), global stats occupy the full 12 columns in a horizontal strip below.
2. THE Market_Core widget on the Crypto Overview SHALL use the existing `MarketCoreWidget` component with the following visual enhancements: (a) the surrounding Panel uses a gradient border that shifts hue based on regime (green for BULL, red for BEAR, blue for SIDEWAYS), (b) a regime label badge renders below the canvas with `SPRING_DEFAULT` scale animation when the regime changes.
3. THE price display on each overview card SHALL use Number_Morph: WHEN the live price updates via Zustand `marketStore`, THE displayed number SHALL animate digit-by-digit using Framer Motion rather than snapping.
4. THE Sentiment card on the Crypto Overview SHALL be redesigned as a horizontal stat strip with: a Fear & Greed arc gauge (SVG, 0–100 scale), funding rate indicator (color-coded: green if < 0.01%, yellow if 0.01–0.05%, red if > 0.05%), OI trend arrow, and L/S ratio bar.
5. THE Quick Signals section SHALL be redesigned as a compact 3-column signal grid where each cell shows: action badge (LONG/SHORT/WAIT), symbol, confidence ring, and a one-line rationale — clicking a cell SHALL expand it in-place using `AnimatePresence` to show entry/stop/target without navigation.
6. WHEN the Best Time banner is rendered, THE banner SHALL use a `SPRING_GENTLE` entrance animation and SHALL visually encode the current window quality via a background that shifts from neutral (score < 40) to a subtle brand tint (score > 70).
7. THE Crypto Overview page SHALL meet WCAG 2.1 AA contrast requirements: all text elements SHALL have a contrast ratio of at least 4.5:1 against their background in both light and dark mode.

---

### Requirement 6: India Overview Page Redesign

**User Story:** As an NSE F&O trader, I want the India Overview page to be a mission-control dashboard with regime awareness, live index pulse, and top picks visible without scrolling.

#### Acceptance Criteria

1. THE India Overview page SHALL use a `Bento_Grid` layout: the Market_Core widget occupies the top-left (4 columns × 3 rows), NIFTY/BANKNIFTY/FINNIFTY index strips occupy the top-center (5 columns × 1 row each, stacked), and Top 5 Stocks for Tomorrow occupies the top-right (3 columns × 3 rows).
2. THE NIFTY index strip SHALL render: index value (Number_Morph), day change (color-coded), percentage change, and a 20-bar sparkline — sourced from the existing `useIndiaMarketStore` snapshot.
3. THE MSB Signals section SHALL be redesigned using TanStack_Table with columns: Symbol, Signal Type, Strength (0–100 bar), Entry, Stop, Time — with row-level `data-density="compact"` and `SPRING_MICRO` row entrance animations on data load.
4. THE Range Expansion Scanner section SHALL be rendered as a horizontal scrollable chip strip above the MSB table — each chip shows symbol, WR8 status badge, and day change — clicking a chip SHALL highlight the corresponding row in the MSB table.
5. THE Order Flow Panel (VPIN gauge) SHALL be redesigned as a compact 2-column widget: left column shows the gauge arc (0–1 scale), right column shows a 20-bar VPIN sparkline — using `--color-data-positive` (benign) and `--color-data-negative` (toxic) for coloring.
6. THE Top 5 Stocks section SHALL render each stock as a ranked card with: rank number, symbol, sector badge, signal badge (color-coded), price + day change, and a mini score bar — with `SPRING_GENTLE` stagger animation on load.
7. WHEN the India Overview page loads, THE Market_Core widget SHALL entrance-animate using a `SPRING_GENTLE` scale-from-0.8 transition starting from transparent — the 3D canvas SHALL only mount after the parent Panel is fully visible (using an `IntersectionObserver`).
8. THE India Overview page SHALL include a `Regime_Reactive` banner strip at the very top (below the MarketTickerBar): a full-width 28px strip that shows the current regime label and a human-readable context sentence — this strip SHALL change background color based on regime using `--color-regime-{regime}` tokens.

---

### Requirement 7: AI Signals Page Redesign

**User Story:** As a trader, I want the AI Signals page to feel like a real institutional research terminal — with filtering, confidence visualization, and trade plan density — not a list of generic cards.

#### Acceptance Criteria

1. THE AI Signals page SHALL render a `AiMarketContextBanner` at the top with a redesigned layout: regime classification on the left (icon + label + confidence%), a 5-factor summary bar in the center (each factor shown as a small icon + value), and regime-change timestamp on the right.
2. THE AI signal grid SHALL use a masonry-like layout for desktop (2 columns on `lg`, 1 column on mobile) where cards of different signal strengths have proportional heights — WAIT signals are rendered at 60% the height of active signals.
3. THE `AiSignalCard` SHALL be refactored to match the IIT design: (a) the top accent line SHALL be 2px and use `--color-data-{positive|negative}` instead of the action accent color, (b) the confidence ring SHALL animate its fill arc using `SPRING_DEFAULT` when the page loads, (c) the take-profit ladder SHALL use a horizontal progress track visualization instead of three separate boxes.
4. THE direction / horizon filter strip SHALL be redesigned as a segmented control pill using `layoutId="signal-filter-pill"` for the active state indicator — persisting selection to localStorage as before.
5. WHEN the user hovers over a Signal_Card for more than 300ms, THE Signal_Card SHALL expand vertically using `AnimatePresence` to reveal: SHAP factor breakdown (from the existing `signal.confluences` data), a mini payoff diagram if `signal.strike` is available, and the exact invalidation criteria — collapsing on mouse-leave with `SPRING_FAST`.
6. THE AI Signals page SHALL render a "Stale" overlay on any card whose `timing.exitBy` has elapsed — the overlay SHALL be a frosted glass panel with a "Signal Expired" label centered over the card, with a "Refresh" action that triggers manual refetch.
7. THE Number_Morph animation SHALL be applied to the `confidenceScore` value on every `AiSignalCard` — animating from 0 to the actual value on initial page load, with a 50ms stagger between cards.

---

### Requirement 8: AI Stock Radar (TanStack Table Component)

**User Story:** As a trader, I want a dense, sortable AI Stock Radar table to screen all F&O stocks at a glance — with hover detail panels showing model confidence — without opening a separate page.

#### Acceptance Criteria

1. THE AI_Radar component SHALL be implemented using TanStack_Table v9 with the following columns: Rank, Stock (symbol + sector badge), AI Score (0–100 bar with color gradient), Momentum (5-day sparkline), Volume (relative volume bar), OI Build-Up (ΔOI indicator arrow), Regime (color-coded badge), and Signal (LONG/SHORT/WAIT badge).
2. THE AI_Radar SHALL support multi-column sorting: clicking a column header SHALL toggle asc/desc/none, with a spring-animated sort indicator arrow.
3. THE AI_Radar SHALL support client-side filtering via a search input above the table — filtering on symbol name and sector — with results animated using `AnimatePresence` to smoothly reorder rows.
4. WHEN the user hovers a row in the AI_Radar for more than 200ms, THE AI_Radar SHALL render a `Hover_Detail_Panel` anchored to the right of the row: the panel SHALL show confidence breakdown (each confluence factor as a horizontal bar), win probability, entry/stop/TP1 levels, and a "Trade" button that opens the full `AiSignalCard` in a modal.
5. THE Hover_Detail_Panel SHALL animate in using `SPRING_FAST` from opacity 0, scale 0.95 — and SHALL close with `SPRING_MICRO` on mouse-leave.
6. THE AI_Radar SHALL use `data-density="compact"` by default and allow toggling to `data-density="comfortable"` via a density toggle button in the table toolbar.
7. THE AI_Radar SHALL be placed on the India AI Signals page below the existing `AiSignalsBoard` as a secondary "Quick Scan" section — toggled visible via a "Show Radar" button — and SHALL use the same data already fetched by the existing `/api/in/ai-signals` polling hook.
8. THE AI_Radar table SHALL be keyboard-navigable: `Tab` moves focus to the next row, `Enter` expands the Hover_Detail_Panel inline, `Escape` collapses it — meeting WCAG 2.1 AA keyboard accessibility requirements.

---

### Requirement 9: Chart Component Enhancements

**User Story:** As a trader, I want the price chart to display institutional-grade overlays (candlesticks, volume, VWAP, EMA, breakout signals) rendered cleanly on the IIT design system — not a default TradingView clone.

#### Acceptance Criteria

1. THE `PriceChart` component (`src/components/india/charts/price-chart.tsx`) SHALL be refactored to consume IIT design tokens: chart background SHALL use `--color-bg`, grid lines SHALL use `--color-panel-border`, up candles SHALL use `--color-data-positive`, and down candles SHALL use `--color-data-negative`.
2. THE `PriceChart` SHALL render a toolbar above the chart with: timeframe selector (1m, 5m, 15m, 1h, 1D), indicator toggles (VWAP, EMA 9/21/50, Volume Profile, Signals), and a fullscreen button — the toolbar SHALL use `data-density="compact"` row height.
3. WHEN the VWAP toggle is active, THE `PriceChart` SHALL overlay the anchored VWAP plugin (session/daily/weekly anchors) already implemented in Phase 2 — each VWAP line SHALL use a distinct color from the IIT palette: session VWAP in `--color-brand`, daily in `--color-info`, weekly in `--color-fg-muted`.
4. WHEN the Signals toggle is active, THE `PriceChart` SHALL render signal arrows at the trigger bar: bullish signals as upward-pointing triangles in `--color-data-positive`, bearish signals as downward-pointing triangles in `--color-data-negative` — using the Lightweight Charts v5 marker API.
5. THE `PriceChart` SHALL react to theme changes via the existing `useTheme()` hook and call `chart.applyOptions()` with the new palette without destroying and recreating the chart instance — exactly as the existing implementation already does.
6. THE `PriceChart` toolbar timeframe buttons SHALL use `layoutId="chart-tf-pill"` for the active indicator with `SPRING_FAST` animation — consistent with the tab/filter patterns used across the app.
7. WHEN the chart enters fullscreen mode, THE `PriceChart` SHALL expand to fill the viewport using a Framer Motion `layoutId` shared layout animation rather than a separate modal overlay.

---

### Requirement 10: Trading Component Library

**User Story:** As a developer implementing the overhaul, I want a set of IIT-standard trading-specific components so that new pages don't need to invent their own layout and design patterns.

#### Acceptance Criteria

1. THE component library SHALL provide a `SignalBadge` component that renders LONG/SHORT/BUY/SELL/WAIT with standardized colors, sizing, and optional icon — replacing all ad-hoc badge implementations across pages.
2. THE component library SHALL provide a `ConfidenceBar` component: a horizontal bar 0–100 with gradient fill from `--color-data-neutral` (0) through `--color-data-positive` (100), with optional numeric label — used in AI Radar rows and signal cards.
3. THE component library SHALL provide a `RegimeBadge` component that renders BULL/BEAR/SIDEWAYS/HIGH_VOL/UNKNOWN with the corresponding `--color-regime-*` token, an icon, and an animated entrance using `SPRING_MICRO`.
4. THE component library SHALL provide a `NumberMorph` component (wrapping Framer Motion's `animate` for numbers) that smoothly interpolates between numeric values — accepting `value: number`, `prefix?: string`, `suffix?: string`, `decimals?: number`, and `className?: string` props.
5. THE component library SHALL provide a `StatGrid` component: a responsive CSS grid of stat cells, each showing a label (font-label class) and a value (font-data class) — accepting an `items` array and a `cols` prop (2, 3, or 4).
6. THE component library SHALL provide a `PanelHeader` component: a 40px row with a title (left-aligned), an optional icon, an optional badge, and optional action slot (right-aligned) — used as the header for every Panel on dashboard pages.
7. THE component library SHALL provide a `RiskMeter` component: a vertical or horizontal gauge showing current risk exposure on a 0–100 scale, using a segmented bar (green 0–33, yellow 33–66, red 66–100) — used on Paper Trading and Position panels.
8. WHEN any component in the library receives a `loading={true}` prop, THE component SHALL render an appropriate skeleton state using the existing `Skeleton` primitive — skeleton states MUST match the exact dimensions of the loaded state to prevent layout shift.

---

### Requirement 11: Zustand Store Architecture for UI State

**User Story:** As a developer, I want a dedicated Zustand store for high-frequency UI state so that animation triggers, regime reactions, and layout preferences don't pollute existing data stores.

#### Acceptance Criteria

1. THE `UIStore` (`src/store/uiStore.ts`) SHALL manage the following slices: `sidebarCollapsed: boolean`, `commandPaletteOpen: boolean`, `activeRegime: MarketRegime`, `tableDensity: "compact" | "default" | "comfortable"`, `chartFullscreen: boolean`, and `radarVisible: boolean`.
2. THE `UIStore` SHALL expose actions: `toggleSidebar()`, `openCommandPalette()`, `closeCommandPalette()`, `setRegime(regime)`, `setDensity(density)`, `setChartFullscreen(v)`, and `toggleRadar()`.
3. THE `sidebarCollapsed` state SHALL be persisted to `localStorage` under the key `af-ui-sidebar-collapsed` using Zustand's persist middleware — so sidebar state survives page reloads.
4. THE `tableDensity` state SHALL be persisted to `localStorage` under the key `af-ui-table-density`.
5. THE `activeRegime` SHALL be synchronized from `useIndiaMarketStore` on the India market surface and from a derived crypto regime on the Crypto surface — the `UIStore` `setRegime` action SHALL be called by a `useEffect` in the respective market store consumers, not via direct store coupling.
6. WHILE `commandPaletteOpen` is true, THE `UIStore` SHALL block body scroll — implemented via a `useEffect` that toggles `document.body.style.overflow`.
7. THE `UIStore` SHALL be a single store (not split into separate files) to minimize provider nesting — consistent with the existing store architecture.

---

### Requirement 12: Regime-Reactive UI System

**User Story:** As a trader, I want the UI to subtly reflect the live market regime — calm animations in neutral markets, pulse effects on breakouts, risk warnings in high volatility — so that the platform feels alive and data-driven.

#### Acceptance Criteria

1. THE `Regime_Reactive` system SHALL be implemented as a React context (`RegimeContext`) exported from `src/lib/regime-context.tsx` — wrapping the `(dashboard)` layout and consuming the `UIStore` `activeRegime` value.
2. WHEN the active regime changes to `BULL`, THE Shell background aurora animation SHALL smoothly transition its `--aurora-a` color toward `oklch(0.50 0.18 155)` (green) over 1200ms using CSS transitions — not a JavaScript frame loop.
3. WHEN the active regime changes to `BEAR`, THE Shell background aurora animation SHALL smoothly transition its `--aurora-a` color toward `oklch(0.42 0.18 22)` (red) over 1200ms.
4. WHEN the active regime changes to `SIDEWAYS`, THE Shell background aurora animation SHALL revert to the default neutral aurora palette over 1200ms.
5. WHEN a breakout signal is detected (confidence score ≥ 80 on an active AI signal), THE `Regime_Reactive` system SHALL trigger a single radial pulse animation originating from the Market_Core widget position — implemented as a CSS `@keyframes` animation on a temporary overlay element, lasting 600ms, not repeating.
6. WHEN the India VIX exceeds 25 (high volatility), THE Topbar SHALL render a persistent `Risk Warning` chip next to the ConnectionPill — using `--color-data-negative` background and a slow 2s pulse animation on the border — the chip SHALL disappear when VIX drops below 22.
7. THE `Regime_Reactive` system SHALL respect `prefers-reduced-motion`: WHEN the media query is active, ALL animation-based regime reactions SHALL be replaced with instant color changes — no pulsing, no transitions longer than 100ms.
8. WHEN the regime changes, THE `RegimeBadge` components across all visible panels SHALL update with a `SPRING_MICRO` scale animation on the text content — not a full component remount.

---

### Requirement 13: 3D Component Suite

**User Story:** As a trader, I want selective 3D elements that add depth and data encoding — not gratuitous decoration — to key pages: the Market Core on Overview pages, a Risk Sphere on Paper Trading, and an optional Portfolio Galaxy.

#### Acceptance Criteria

1. THE `MarketIntelligenceCore` component (already implemented) SHALL be refactored to accept a `quality` prop (`"low" | "medium" | "high"`) that controls geometry resolution: `low` uses 32×32 sphere segments (mobile/low-end), `medium` uses 64×64 (default), `high` uses 128×128 (desktop/high-end) — defaulting to `"medium"`.
2. WHEN `prefers-reduced-motion` is active, THE `MarketIntelligenceCore` SHALL render a static non-animated version using the same colors — implementing this via a `useReducedMotion()` hook from Framer Motion passed to the R3F scene to halt frame updates.
3. THE component library SHALL provide a `RiskSphere` component in `src/components/3d/risk-sphere.tsx`: a simplified R3F sphere (no `MeshDistortMaterial` to reduce GPU cost) whose color, opacity, and scale encode the current portfolio risk level (0–100) — green at low, yellow at medium, red at high risk.
4. THE `RiskSphere` SHALL be used on the Paper Trading page inside the stats panel — replacing the current static risk label — rendered at 120×120px maximum.
5. THE component library SHALL provide a `PortfolioGalaxy` component in `src/components/3d/portfolio-galaxy.tsx`: an R3F particle system where each particle represents a portfolio position, with particle size encoding position size and particle color encoding P&L sign — the galaxy rotates slowly and responds to mouse position via `useFrame`.
6. THE `PortfolioGalaxy` SHALL be placed on the India Portfolio Optimizer page (`/in/portfolio`) as an optional visualization tab — dynamically imported via `next/dynamic` with `ssr: false` to keep Three.js out of the initial bundle.
7. ALL 3D components SHALL use `next/dynamic` with `ssr: false` and SHALL provide a skeleton loading state matching the canvas dimensions — preventing layout shift during hydration.
8. ALL 3D components SHALL clean up their R3F renderer on unmount to prevent WebGL context accumulation — implemented via R3F's built-in cleanup lifecycle.

---

### Requirement 14: Page-Level Layout Standards

**User Story:** As a trader, I want consistent page structure across all dashboard pages — the same header pattern, the same section spacing, the same empty states — so the platform feels unified.

#### Acceptance Criteria

1. EVERY page in the `(dashboard)` route group SHALL render a `PageHeader` component as its first child: a flex row with `<h1>` title (text-xl, font-semibold), an optional subtitle (text-sm, fg-muted), and an optional right-slot for actions — consistent spacing of `mb-6`.
2. THE `PageHeader` SHALL accept a `regime` prop: WHEN provided, it SHALL render a `RegimeBadge` inline with the title.
3. ALL data tables on dashboard pages SHALL use `data-density="compact"` by default with a density toggle in the table toolbar — the toggle MUST write to the `UIStore` `tableDensity` slice so the preference persists across page navigations.
4. ALL empty states across dashboard pages SHALL use a standardized `EmptyState` component: centered, with an icon (Lucide), a heading, a description, and an optional action button — never a raw "No data" text node.
5. ALL error states SHALL use a standardized `ErrorState` component: centered, with a red-tinted icon, an error message sourced from the caught error, and a "Retry" action that triggers the nearest TanStack Query `refetch()`.
6. ALL loading states SHALL use skeleton components that match the exact layout of the loaded state — validated by rendering both states in the same DOM tree position.
7. THE `PageHeader`, `EmptyState`, `ErrorState`, and related layout primitives SHALL be exported from `src/components/ui/page-layout.tsx` — a single file containing all layout primitives for the overhaul.
8. WHEN a page transitions via Next.js navigation, THE page content SHALL enter with a `SPRING_GENTLE` fade-from-below animation — implemented as a wrapper `motion.div` in the page's default export, NOT in the layout file (to avoid animating the shell).

---

### Requirement 15: Responsive Design and Accessibility

**User Story:** As a trader using the platform on different devices, I want the dashboard to be fully usable on desktop (1440px+), laptop (1280px), and tablet (768px) widths — with graceful degradation on mobile.

#### Acceptance Criteria

1. THE `Bento_Grid` layout on Overview pages SHALL reflow to a single-column stacked layout below `768px` — all Bento cells SHALL stack in order of visual priority (Market Core first, then price cards, then signals).
2. THE Sidebar SHALL automatically collapse to icon-only mode below `1024px` viewport width — reading from a `useBreakpoint` hook that observes `window.innerWidth`, NOT a CSS media query that hides DOM elements.
3. THE MarketTickerBar SHALL hide the scrolling ticker on viewports below `640px` and SHALL instead render a static 2-chip strip (BTC + NIFTY or BTC + ETH depending on market) with no animation.
4. ALL interactive elements (buttons, links, table rows, chip toggles) SHALL have a minimum touch target of `44×44px` on touch-capable devices — implemented via minimum padding/margin, NOT minimum width/height that distort layout.
5. THE `AiSignalCard` SHALL reflow its 3-column stat grid to 2-column below `480px` and 1-column below `360px` using CSS grid `auto-fit` with a `minmax(120px, 1fr)` track.
6. THE `AI_Radar` table SHALL render in a horizontally scrollable container on viewports below `1024px` — NOT with hidden columns — so all data remains accessible.
7. ALL color choices in the Design_System SHALL meet WCAG 2.1 AA contrast: `--color-fg` on `--color-bg` SHALL have a contrast ratio ≥ 4.5:1 in both light and dark mode; `--color-fg-muted` on `--color-surface` SHALL have a contrast ratio ≥ 3:1.
8. THE platform SHALL support keyboard-only navigation across the entire shell: sidebar items, topbar actions, ticker chips, table rows, and modal dialogs — all focusable via `Tab` with a visible 2px `--color-brand` focus ring.

---

### Requirement 16: Animation Quality Standards

**User Story:** As a trader, I want animations to feel precise and purposeful — adding information and satisfaction — not decorative or distracting, and never blocking interaction.

#### Acceptance Criteria

1. THE Motion_System SHALL enforce a rule: NO animation SHALL delay user interaction — all interactive elements SHALL be clickable/focusable immediately, animations run in parallel (never as a prerequisite to interaction).
2. ALL page-entrance animations SHALL complete within 400ms — measured from the first render frame to the final resting state, using `SPRING_GENTLE` (stiffness 240, damping 24).
3. ALL micro-interaction animations (button press, hover lift, badge entrance) SHALL complete within 180ms — using `SPRING_FAST` or `SPRING_MICRO` presets.
4. THE `Number_Morph` animation duration SHALL be proportional to the magnitude of change: changes under 1% of the value's scale use 120ms, changes 1–10% use 240ms, changes over 10% use 360ms — capped at 360ms.
5. THE `Regime_Reactive` aurora background color transition SHALL use CSS `transition: background-color 1200ms ease` — NOT a JavaScript animation — to avoid blocking the main thread.
6. ALL animations MUST be disabled when `prefers-reduced-motion: reduce` is set in the user's OS — implemented via Framer Motion's `useReducedMotion()` hook at the top level and passed as a `reducedMotion` context value to child components.
7. THE Market_Core 3D sphere SHALL target 60fps on a mid-range device (equivalent to MacBook Air M1) using the `dpr={[1, 1.5]}` Canvas prop already set — performance MUST NOT degrade below 30fps when the sphere is visible.
8. WHEN multiple AI Signal Cards are loading simultaneously, THE cards SHALL entrance-animate with a 40ms stagger between consecutive cards — not all at once — using Framer Motion's `staggerChildren` in a `motion.div` container.

---

### Requirement 17: Component File and Directory Architecture

**User Story:** As a developer, I want a clear, consistent file structure for all new UI components so that any team member can find and modify any component without searching.

#### Acceptance Criteria

1. THE component architecture SHALL follow this directory structure: `src/components/ui/` for generic primitives (shadcn-style, market-agnostic), `src/components/trading/` for trading-specific components (SignalBadge, ConfidenceBar, RegimeBadge, RiskMeter, etc.), `src/components/charts/` for chart components (PriceChart, VolumeProfile, OIChart), `src/components/3d/` for Three.js/R3F components (MarketGlobe, RiskSphere, PortfolioGalaxy), and `src/components/layout/` for shell and page layout components (PageHeader, EmptyState, ErrorState, Sidebar, Topbar).
2. EVERY component file SHALL export exactly one primary named export that matches the filename in PascalCase — no default exports in component files.
3. THE `src/components/trading/` directory SHALL contain these components at minimum: `SignalBadge.tsx`, `ConfidenceBar.tsx`, `RegimeBadge.tsx`, `NumberMorph.tsx`, `StatGrid.tsx`, `PanelHeader.tsx`, `RiskMeter.tsx`, and `AiRadar.tsx`.
4. THE `src/components/layout/` directory SHALL contain: `PageHeader.tsx`, `EmptyState.tsx`, `ErrorState.tsx`, `BentoGrid.tsx`, and `PageTransition.tsx`.
5. WHEN a component is moved from its current location to the new directory structure, ALL existing import statements across the codebase SHALL be updated — no orphaned imports.
6. THE `src/lib/motion-presets.ts` file SHALL export the four named Spring constants and additionally export a `TRANSITION_STAGGER` helper function: `stagger(count: number, baseDelay = 0.04): MotionProps` that returns the correct `transition` object for staggered list animations.
7. THE `src/store/uiStore.ts` SHALL follow the same Zustand v5 store pattern used by `src/store/india/marketStore.ts` — using `create` with a typed state interface, not the older `createStore` API if the codebase already uses the newer pattern.

---

### Requirement 18: Daily Picks Page Redesign (India)

**User Story:** As an NSE F&O trader, I want the Daily Picks page to feel like a high-stakes trading desk briefing — clear, confident, with live P&L tracking that tells me instantly whether my picks are working.

#### Acceptance Criteria

1. THE Daily Picks page SHALL render each bucket (Indices Scalping, Opening Breakout, Highly Momentum, Highly Scalping, Highly Potential) as a distinct horizontal section with a section header using `PanelHeader` and a horizontal scroll grid of pick cards on mobile.
2. EACH pick card SHALL display: rank badge, symbol (large, `font-data`), signal direction icon (▲▼), entry/stop/target in a compact 3-cell grid, current P&L as a `NumberMorph` component (updating every 30s from the existing polling), a status badge (OPEN/TARGET_HIT/STOP_HIT/CLOSED), and a progress bar showing how far price has moved toward target.
3. WHEN a pick status changes to `TARGET_HIT`, THE pick card SHALL play a 800ms green celebration pulse animation (border glow + scale) — respecting `prefers-reduced-motion`.
4. WHEN a pick status changes to `STOP_HIT`, THE pick card SHALL play a 500ms red flash animation (border pulse) — respecting `prefers-reduced-motion`.
5. THE Expiry Trades section (Gamma Blast / Hero Zero) SHALL be rendered in a distinct Panel with a prominent `Regime_Reactive` header that shows expiry countdown timer — the countdown SHALL use `Number_Morph` and SHALL update every second.
6. THE Daily Picks history tab SHALL be redesigned using TanStack_Table with columns: Date, Bucket, Symbol, Entry, Target, Stop, Exit, P&L%, Status, Duration — with sortable headers and client-side filtering by bucket and status.
7. THE FnO Trend Scanner sections (Bullish/Bearish) on the Daily Picks page SHALL be rendered as collapsible `details`/`summary` panels with an animated chevron — collapsed by default — to reduce initial page density.

---

### Requirement 19: Paper Trading and Positions Page Redesign

**User Story:** As a trader running paper trades, I want the paper trading page to show live P&L with visual risk indicators — not just a flat table — so I can monitor my simulated portfolio at a glance.

#### Acceptance Criteria

1. THE Paper Trading page SHALL render an Open Positions section using TanStack_Table with columns: Strategy (badge), Symbol, Direction, Entry, Mark Price (live, `NumberMorph`), P&L% (color-coded, `NumberMorph`), P&L$ (color-coded), Duration, and Actions (Close button).
2. THE stats panel on the Paper Trading page SHALL use a `BentoGrid` sub-layout: total P&L (large, `NumberMorph`, bull/bear colored) occupies 2 columns, win rate (with a circular arc gauge) occupies 1 column, and the `RiskSphere` occupies 1 column — all in a 4-column row.
3. THE Journal table SHALL use `data-density="compact"` with TanStack_Table — featuring sortable Date, Symbol, Strategy, Entry, Exit, P&L%, Status, and Notes columns.
4. THE performance breakdown section SHALL render a per-strategy bar chart using `lightweight-charts` line series (not Recharts) — consistent with the existing chart library — showing cumulative P&L per strategy over time.
5. WHEN a paper trade row has P&L% ≥ +5%, THE row SHALL have a subtle green left-border (2px, `--color-data-positive`) — implemented as a CSS class added to the `<tr>` element via TanStack Table's `meta` API.
6. WHEN a paper trade row has P&L% ≤ -3%, THE row SHALL have a subtle red left-border (2px, `--color-data-negative`).
7. THE Close All Positions button SHALL require a double-confirm interaction: first click shows a confirmation tooltip using the `Tooltip` Radix primitive, second click within 3 seconds executes — preventing accidental mass-close.

---

### Requirement 20: Options Chain Page Redesign

**User Story:** As an options trader, I want the NSE option chain to render as a precision analytics table — dense with data, clean in layout, with Greeks, IV, and GEX visible without horizontal scrolling on a 1440px display.

#### Acceptance Criteria

1. THE Options Chain table SHALL be implemented using TanStack_Table with the following column layout: `[Strike | CE IV | CE Delta | CE OI | CE ΔOI | CE LTP | (Strike Center) | PE LTP | PE ΔOI | PE OI | PE Delta | PE IV]` — 12 columns total.
2. THE strike center column SHALL render the strike price in `--font-data` style with background color encoding proximity to max-pain: ATM strike uses `--color-brand/20` background, the max-pain strike uses `--color-warning/20`, other strikes use transparent.
3. THE CE/PE IV columns SHALL render the IV value alongside a small heat-indicator dot: green if IV < 20%, yellow if 20–40%, red if > 40%.
4. THE Greeks toggle SHALL reveal `Delta` and `Gamma` columns via an animated column slide-in (Framer Motion `AnimatePresence` on the column header and cells).
5. THE GEX Panel SHALL be placed below the options chain table as a collapsible section — expanded by default — showing the existing bar chart with the gamma flip level highlighted.
6. THE IV Surface panel SHALL be placed in a tabbed interface alongside the chain table: tabs are "Chain", "IV Surface", "GEX", "Payoff" — the tab indicator SHALL use `layoutId="options-tab-pill"` with `SPRING_FAST` animation.
7. THE PCR and Max Pain stats SHALL be rendered in a compact horizontal strip above the chain table using `StatGrid` — showing PCR value (color-coded: > 1.4 green, < 0.8 red), max pain strike, ATM IV, and IV regime badge.

