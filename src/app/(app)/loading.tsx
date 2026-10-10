import { Skeleton } from "@/components/ui/skeleton";

/** 应用区路由切换骨架屏(消除切页白屏)。 */
export default function AppLoading() {
  return (
    <div className="w-full space-y-4 px-4 py-8 lg:px-10">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}
