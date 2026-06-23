export default function AuthLoading(): JSX.Element {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <div className="space-y-3">
        <div className="h-2 w-24 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
        <div className="h-12 w-72 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
        <div className="h-3 w-full animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
        <div className="mt-6 space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-2 w-12 animate-pulse rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
              <div className="h-11 w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-tinted)]" />
            </div>
          ))}
          <div className="h-11 w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-tinted)]" />
        </div>
      </div>
    </div>
  );
}
