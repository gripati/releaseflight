import { Card, Skeleton } from "@marquee/ui";

export default function PulseLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-44" />
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-7 w-16" />
          </Card>
        ))}
      </div>
      <Card className="space-y-3">
        <Skeleton className="h-2.5 w-32" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" />
        ))}
      </Card>
    </div>
  );
}
