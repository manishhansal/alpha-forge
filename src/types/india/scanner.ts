// Scanner result types. Each scanner produces a list of `ScannerHit` rows.

export type ScannerType =
  | "oi-buildup"
  | "pcr"
  | "iv-spike"
  | "volume-breakout"
  | "momentum"
  | "range-expansion";

export type OiBuildupKind =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "LONG_UNWINDING"
  | "SHORT_COVERING";

export type ScannerHit = {
  symbol: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  metric: number;
  metricLabel: string;
  kind?: OiBuildupKind | string;
  note?: string;
};

export type ScannerResult = {
  type: ScannerType;
  title: string;
  description: string;
  hits: ScannerHit[];
  fetchedAt: string;
};
