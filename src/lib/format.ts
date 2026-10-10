export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "未知";

  const diff = Date.now() - then;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return "昨天";
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;

  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(iso));
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}
