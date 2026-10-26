"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "@/components/layout/theme-toggle";

/** 落地页导航:xl+ 且未滚动时叠加在沉浸式 Hero 上(透明白字),滚动后或窄屏恢复实底。 */
export function LandingHeader({
  signedIn,
  destination,
}: {
  signedIn: boolean;
  destination: string;
}) {
  const [immersive, setImmersive] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const update = () => setImmersive(mq.matches && window.scrollY <= 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    mq.addEventListener("change", update);
    return () => {
      window.removeEventListener("scroll", update);
      mq.removeEventListener("change", update);
    };
  }, []);

  const linkClass = immersive
    ? "text-white/85 transition-colors hover:text-white"
    : "text-muted transition-colors hover:text-foreground";

  return (
    <header
      className={
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300 " +
        (immersive
          ? "border-b border-transparent bg-transparent"
          : "border-b border-line bg-background/85 backdrop-blur-xl")
      }
    >
      <div className="landing-shell flex h-20 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-3"
          aria-label="GraduateStudio 首页"
        >
          <Image
            src={
              immersive
                ? "/brand/graduatestudio-mark-white-v2.png"
                : "/brand/graduatestudio-mark-transparent.png"
            }
            alt=""
            width={490}
            height={217}
            preload
            className={"h-10 w-auto " + (immersive ? "" : "dark:invert")}
          />
          <span
            className={
              "text-base font-semibold tracking-tight " +
              (immersive ? "text-white" : "")
            }
          >
            GraduateStudio
            <span
              className={
                "mt-0.5 hidden font-mono text-[10px] font-normal tracking-[.14em] sm:block " +
                (immersive ? "text-white/60" : "text-muted")
              }
            >
              BY SEVN AILAB
            </span>
          </span>
        </Link>
        <nav
          className="hidden flex-1 items-center justify-center gap-10 text-[15px] md:flex"
          aria-label="主导航"
        >
          <a href="#features" className={linkClass}>
            核心能力
          </a>
          <a href="#workflow" className={linkClass}>
            项目流程
          </a>
          <a href="#faq" className={linkClass}>
            常见问题
          </a>
        </nav>
        <div
          className={
            "flex items-center gap-1.5 rounded-full p-1.5 transition-colors duration-300 " +
            (immersive
              ? "bg-neutral-950/35 backdrop-blur-md ring-1 ring-white/15"
              : "")
          }
        >
          <ThemeToggle
            className={
              (immersive
                ? "border-white/25 bg-transparent text-white/85 hover:bg-white/10 hover:text-white"
                : "") + " h-10 w-10"
            }
          />
          {!signedIn && (
            <Link href="/login" className={"hidden pr-2 text-[15px] sm:block " + linkClass}>
              登录
            </Link>
          )}
          <Link
            href={destination}
            className={
              "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-medium transition " +
              (immersive
                ? "bg-white text-neutral-900 hover:opacity-90"
                : "bg-foreground text-background hover:opacity-85")
            }
          >
            {signedIn ? "进入工作台" : "开始创建"}
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
