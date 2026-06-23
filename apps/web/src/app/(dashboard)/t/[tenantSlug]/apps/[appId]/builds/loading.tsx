import { Card, Skeleton } from "@marquee/ui";

export default function ReleaseLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-48" />
          <Skeleton className="h-6 w-32" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i} className="space-y-3">
          <Skeleton className="h-2.5 w-24" />
          {Array.from({ length: 3 }).map((_, j) => (
            <Skeleton key={j} className="h-3.5 w-full" />
          ))}
        </Card>
      ))}
    </div>
  );
}
