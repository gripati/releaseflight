import { Card, Skeleton } from "@marquee/ui";

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-40" />
          <Skeleton className="h-7 w-36" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <Card className="p-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b-[0.5px] border-[var(--stroke-default)] px-4 py-3.5 last:border-b-0">
            <Skeleton className="h-8 w-8 rounded-[var(--radius-xs)]" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </Card>
    </div>
  );
}
