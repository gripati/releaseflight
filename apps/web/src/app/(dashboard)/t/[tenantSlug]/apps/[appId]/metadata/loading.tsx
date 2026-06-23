import { Card, Skeleton, SkeletonLines } from "@marquee/ui";

export default function MetadataLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-16 rounded-full" />
          ))}
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* Selected locale form */}
      <Card className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-8 w-28" />
        </div>
        {/* 7 fields — name, subtitle, description, keywords, whatsNew, urls */}
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2.5 w-20" />
            {i === 2 || i === 4 ? (
              <SkeletonLines count={4} />
            ) : (
              <Skeleton className="h-11 w-full" />
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
