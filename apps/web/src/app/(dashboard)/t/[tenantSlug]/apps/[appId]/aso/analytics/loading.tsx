import { Card, Skeleton } from "@marquee/ui";

export default function AsoAnalyticsLoading(): JSX.Element {
  return (
    <div className="space-y-8">
      <Skeleton className="h-8 w-40" />
      <Card className="space-y-3">
        <Skeleton className="h-3 w-32" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </Card>
    </div>
  );
}
