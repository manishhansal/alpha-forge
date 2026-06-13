import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-4">
        <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
          404
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Off the chart</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-brand-foreground)] transition-opacity hover:opacity-90"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
