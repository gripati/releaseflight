import { Card, Skeleton, SkeletonImage } from "@marquee/ui";

export default function PreviewsLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-44" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      <Card className="p-5">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <SkeletonImage aspect="9 / 16" />
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-2.5 w-1/2" />
                <Skeleton className="h-2.5 w-12" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
