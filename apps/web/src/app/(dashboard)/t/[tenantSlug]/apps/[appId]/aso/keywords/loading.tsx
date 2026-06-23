import { Card, Skeleton } from "@marquee/ui";

export default function AsoKeywordsLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-full" />
      </Card>
      <Card className="space-y-3">
        <Skeleton className="h-3 w-24" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </Card>
    </div>
  );
}
