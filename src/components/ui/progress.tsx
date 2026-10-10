export function Progress({
  value,
  className = "",
  label,
}: {
  value: number;
  className?: string;
  label?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "进度"}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800 ${className}`}
    >
      <div
        className="h-full rounded-full bg-violet-600 transition-[width] duration-500 dark:bg-violet-500"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
