import { Card, Skeleton, SkeletonImage } from "@marquee/ui";

export default function ScreenshotsLoading(): JSX.Element {
  return (
    <div className="space-y-6">
      {/* Toolbar skeleton — locale + display-type selectors */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>

      {/* 5 image-shaped placeholders in a phone-portrait aspect */}
      <Card className="p-5">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <SkeletonImage aspect="9 / 19.5" />
              <Skeleton className="h-2.5 w-3/4" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
