import Link from "next/link";

export default function NotFound(): JSX.Element {
  return (
    <div className="mx-auto flex min-h-[80vh] max-w-xl flex-col items-center justify-center px-6 py-12 text-center">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
        ━━━ 404 ━━━
      </p>
      <h1
        className="font-display text-[44px] leading-[1.05] tracking-[-0.01em]"
        style={{ fontVariationSettings: "'wght' 450" }}
      >
        Not found.
      </h1>
      <p className="mt-3 font-body text-[14px] text-[var(--ink-secondary)]">
        The page you were looking for doesn't exist or you don't have access.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-[var(--radius-xs)] bg-[var(--ink-primary)] px-4 py-2 font-mono text-[12px] text-[var(--surface-paper)] hover:opacity-90"
      >
        Go home
      </Link>
    </div>
  );
}
