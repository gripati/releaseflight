import { Card, Skeleton } from "@marquee/ui";

export default function AsoOverviewLoading(): JSX.Element {
  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-2.5 w-32" />
          </Card>
        ))}
      </section>
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="space-y-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </Card>
        <Card className="md:col-span-2 space-y-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-20 w-full" />
        </Card>
      </section>
    </div>
  );
}
