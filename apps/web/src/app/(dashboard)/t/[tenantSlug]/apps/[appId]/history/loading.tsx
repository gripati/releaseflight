import { Card, Skeleton } from "@marquee/ui";

export default function HistoryLoading(): JSX.Element {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-warm)] px-4 py-3">
        <div className="grid grid-cols-[160px_120px_180px_180px_1fr] gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-2.5" />
          ))}
        </div>
      </div>
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[160px_120px_180px_180px_1fr] gap-3 border-b-[0.5px] border-[var(--stroke-default)] px-4 py-3 last:border-b-0"
        >
          {Array.from({ length: 5 }).map((_, j) => (
            <Skeleton key={j} className="h-3" />
          ))}
        </div>
      ))}
    </Card>
  );
}
