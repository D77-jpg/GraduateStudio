import Link from "next/link";
import Image from "next/image";
import { auth } from "@/server/auth";
import { PROJECT_STAGES, STAGE_LABELS } from "@/lib/projects";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { ButtonLink } from "@/components/ui/button";

const FEATURES = [
  {
    number: "01",
    title: "先想清楚，再开始构建。",
    text: "从选题、需求到系统架构，把模糊的想法拆解为清晰的目标、功能与实现路径。",
    tag: "PLAN / DESIGN",
  },
  {
    number: "02",
    title: "与 AI 协作，保留你的掌控。",
    text: "在同一个工作区查看代码、审阅变更、运行项目并验证结果，让每一次推进都有迹可循。",
    tag: "BUILD / VERIFY",
  },
  {
    number: "03",
    title: "不止能运行，也能讲清楚。",
    text: "围绕真实项目整理毕业设计文档与答辩材料，让开发成果与最终交付保持一致。",
    tag: "DELIVER / PRESENT",
  },
];

export default async function LandingPage() {
  const session = await auth();
  const destination = session?.user ? "/dashboard" : "/register";
  return (
    <div className="min-h-screen overflow-hidden bg-background">
      <header className="border-b border-line bg-surface/70 backdrop-blur-xl">
        <div className="landing-shell flex h-[72px] items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3" aria-label="GraduateStudio 首页">
            <Image
              src="/brand/graduatestudio-mark.png"
              alt=""
              width={490}
              height={217}
              priority
              className="h-9 w-auto dark:invert"
            />
            <span className="text-sm font-semibold tracking-tight">
              GraduateStudio
              <span className="mt-0.5 hidden font-mono text-[9px] font-normal tracking-[.14em] text-muted sm:block">
                BY SEVN AILAB
              </span>
            </span>
          </Link>
          <nav className="flex items-center gap-3 text-sm" aria-label="主导航">
            <a href="#workflow" className="hidden text-muted hover:text-foreground sm:block">
              产品流程
            </a>
            <ThemeToggle />
            {!session?.user && (
              <Link href="/login" className="text-muted hover:text-foreground">
                登录
              </Link>
            )}
            <ButtonLink href={destination} size="sm">
              {session?.user ? "进入工作台" : "开始创建"}
            </ButtonLink>
          </nav>
        </div>
      </header>
      <main id="main-content">
        <section className="relative pt-20 md:pt-28">
          <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0" />
          <div className="landing-shell relative flex flex-col items-center text-center">
            <p className="eyebrow rise">SEVN AILAB / AI 毕业设计工作台</p>
            <h1 className="rise mt-7 text-[clamp(48px,7.5vw,88px)] font-semibold leading-[1.03] tracking-[-.06em]">
              Build your project.
              <br />
              <span className="text-accent">Own the journey.</span>
            </h1>
            <p className="rise mt-7 text-[clamp(22px,3vw,34px)] font-semibold tracking-tight">
              把一个想法，做成完整的毕业设计。
            </p>
            <p className="rise mt-5 max-w-xl text-[15px] leading-8 text-muted md:text-base">
              从选题到答辩，把规划、代码、验证与文档连接起来。
              <br className="hidden sm:block" />与 AI 一起构建，也理解你的每一步。
            </p>
            <div className="rise mt-9 flex flex-wrap justify-center gap-3">
              <ButtonLink href={destination} size="lg">
                {session?.user ? "继续我的项目" : "创建我的第一个项目"}
                <span aria-hidden="true">→</span>
              </ButtonLink>
              <ButtonLink href="#workflow" variant="secondary" size="lg">
                了解完整流程
              </ButtonLink>
            </div>
            <p className="eyebrow mt-8">YOUR IDEAS. YOUR CODE. YOUR PROJECT.</p>
            <div className="brand-panel rise mt-14 w-full max-w-4xl overflow-hidden text-left md:mt-20">
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <span className="eyebrow">PROJECT WORKSPACE</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  从规划到交付
                </span>
              </div>
              <div className="grid md:grid-cols-[1.1fr_1fr]">
                <div className="p-7 md:p-9">
                  <p className="eyebrow">一个项目，一条清晰的路径</p>
                  <h2 className="mt-4 text-2xl font-semibold tracking-tight">
                    让下一步，始终明确。
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-muted">
                    需求、架构、代码与毕业设计材料沉淀在同一个空间。你决定方向，AI 协助推进。
                  </p>
                  <div className="mt-6 flex flex-wrap gap-2">
                    {["需求与架构", "代码与预览", "文档与答辩"].map((label) => (
                      <span
                        key={label}
                        className="rounded-full border border-line px-3 py-1 text-xs text-muted"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <ol className="space-y-4 border-t border-line bg-background/60 p-7 md:border-l md:border-t-0 md:p-9">
                  {[
                    "定义目标与功能边界",
                    "设计结构与数据模型",
                    "协作开发与验证结果",
                    "整理成果与准备答辩",
                  ].map((label, index) => (
                    <li key={label} className="flex items-center gap-4">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs text-accent">
                        0{index + 1}
                      </span>
                      <span className="text-sm font-medium">{label}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </section>
        <section className="landing-shell py-20 md:py-28">
          <div className="flex items-center gap-4 border-b border-line pb-5">
            <p className="eyebrow">
              <span className="text-accent">01</span> / WHY GRADUATESTUDIO
            </p>
          </div>
          <div className="mt-9 grid gap-8 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <article key={feature.number}>
                <p className="eyebrow text-accent">{feature.tag}</p>
                <h2 className="mt-5 text-xl font-semibold tracking-tight">{feature.title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{feature.text}</p>
              </article>
            ))}
          </div>
        </section>
        <section id="workflow" className="border-y border-line bg-surface py-16 md:py-20">
          <div className="landing-shell">
            <p className="eyebrow">
              <span className="text-accent">02</span> / THE PROJECT JOURNEY
            </p>
            <div className="mt-5 flex flex-wrap items-end justify-between gap-5">
              <h2 className="text-3xl font-semibold tracking-tight">一套流程，贯穿始终。</h2>
              <p className="max-w-sm text-sm leading-7 text-muted">
                按阶段推进，也可以按需回访。运行预览、自动开发与版本管理作为工具贯穿开发过程。
              </p>
            </div>
            <ol className="mt-9 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-5">
              {PROJECT_STAGES.map((stage, index) => (
                <li key={stage} className="bg-surface p-5">
                  <span className="font-mono text-xs text-accent">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p className="mt-4 text-sm font-medium">{STAGE_LABELS[stage]}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section className="landing-shell py-16 md:py-20">
          <div className="flex flex-col justify-between gap-8 rounded-2xl bg-foreground p-8 text-background sm:flex-row sm:items-center md:p-12">
            <div>
              <p className="font-mono text-[10px] tracking-[.15em] opacity-60">
                FROM IDEA TO GRADUATION
              </p>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
                从你的下一个想法开始。
              </h2>
              <p className="mt-3 text-sm opacity-65">让每一步开发，都成为你自己的成果。</p>
            </div>
            <Link
              href={destination}
              className="inline-flex shrink-0 items-center justify-center gap-6 rounded-xl bg-background px-6 py-3 text-sm font-medium text-foreground"
            >
              {session?.user ? "进入工作台" : "开始创建项目"}
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="landing-shell flex flex-wrap items-center justify-between gap-4 py-8 text-xs text-muted">
          <p>GraduateStudio · AI 毕业设计工作台</p>
          <a
            href="https://sevnai.site"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono tracking-wide hover:text-accent"
          >
            SEVN AILAB ↗
          </a>
        </div>
      </footer>
    </div>
  );
}
