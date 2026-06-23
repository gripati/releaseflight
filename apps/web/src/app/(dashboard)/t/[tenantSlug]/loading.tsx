/**
 * Streaming UI skeleton — shown by Next.js while the server component
 * for any tenant-scoped page is suspended (DB query, secret fetch, etc).
 *
 * Editorial paper aesthetic: thin pulse on a card-shaped placeholder,
 * never a glow or shimmer that would clash with the design system.
 */
export default function TenantLoading(): JSX.Element {
  return (
    <div className="space-y-6 p-8">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <div className="h-3 w-32 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
          <div className="h-10 w-72 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
          <div className="h-3 w-96 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
        </div>
        <div className="h-10 w-36 animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-tinted)]" />
      </div>
      <div className="grid gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]"
            style={{ animationDelay: `${(i * 80).toString()}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
