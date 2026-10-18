"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/** Only show skeletons for genuinely slow initial loads, not a flash on every click. */
export function WorkspaceLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label="正在加载工作区"
      className="min-h-[60vh] w-full px-4 py-8 lg:px-10"
    >
      {visible ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full max-w-96" />
          <Skeleton className="mt-8 h-64 w-full" />
          <span className="sr-only">正在加载工作区…</span>
        </div>
      ) : null}
    </div>
  );
}
