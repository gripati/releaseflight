import { Card, Skeleton } from "@marquee/ui";

export default function OverviewLoading(): JSX.Element {
  return (
    <div className="space-y-10">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-2.5 w-40" />
          </Card>
        ))}
      </section>

      <section>
        <Skeleton className="mb-4 h-2.5 w-20" />
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[120px_140px_1fr_120px] gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2.5"
            >
              <Skeleton className="h-3" />
              <Skeleton className="h-3" />
              <Skeleton className="h-3" />
              <Skeleton className="h-3" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
