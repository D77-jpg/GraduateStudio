import Link from "next/link";
import Image from "next/image";
import { auth } from "@/server/auth";
import { PROJECT_STAGES, STAGE_LABELS } from "@/lib/projects";
import { LandingHeader } from "@/components/layout/landing-header";
import {
  ChartColumnIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
} from "@/components/icons";

const HIGHLIGHTS = [
  {
    icon: FileTextIcon,
    title: "清晰规划",
    text: "把想法拆解为结构化的目标、功能与里程碑。",
  },
  {
    icon: PencilIcon,
    title: "高效写作",
    text: "论文与文档的每一步都有 AI 协作支持。",
  },
  {
    icon: FolderIcon,
    title: "有条不紊",
    text: "资料、代码与笔记沉淀在同一个工作区。",
  },
  {
    icon: ChartColumnIcon,
    title: "从容答辩",
    text: "整理规范的毕业设计文档与答辩材料。",
  },
];

const FAQS = [
  {
    q: "GraduateStudio 适合谁？",
    a: "正在做毕业设计的本科生与研究生。从选题、需求、开发到答辩，每个阶段都有对应的工作区与 AI 协作支持，按流程推进即可。",
  },
  {
    q: "AI 会替我完成一切吗？",
    a: "不会。你决定方向与标准，AI 负责拆解任务、起草内容与验证结果；所有代码与文档都可审阅、修改与回滚，最终成果始终属于你。",
  },
  {
    q: "最终成果怎么交付？",
    a: "项目支持在线运行与预览，开发过程留有完整版本记录；毕业设计文档与答辩材料可以导出，与实际开发内容保持一致。",
  },
];

export default async function LandingPage() {
  const session = await auth();
  const destination = session?.user ? "/dashboard" : "/register";
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* 全局背景:插画固定铺满视口,内容从其上滚过 */}
      <div aria-hidden="true" className="fixed inset-0 z-0">
        <Image
          src="/brand/hero-sunset.jpg"
          alt=""
          fill
          preload
          sizes="100vw"
          className="object-cover object-right"
        />
      </div>
      <LandingHeader signedIn={Boolean(session?.user)} destination={destination} />
      <main id="main-content" className="relative z-10">
        <section className="relative flex min-h-svh flex-col justify-center pb-20 pt-24">
          {/* 垂直居中的文案块:渐变加高并带中间档,保证中段文字可读,顶部天空保持透亮 */}
          <div aria-hidden="true" className="absolute inset-0">
            <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,.62),rgba(0,0,0,.28)_45%,transparent_78%)]" />
            <div className="absolute inset-x-0 top-0 h-28 bg-[linear-gradient(to_bottom,rgba(0,0,0,.4),transparent)]" />
          </div>
          <div className="landing-shell relative">
            <div className="max-w-xl">
              <p className="eyebrow rise text-white/75">
                SEVN AILAB / AI 毕业设计工作台
              </p>
              <h1 className="rise mt-6 text-[clamp(40px,4.8vw,64px)] font-semibold leading-[1.06] tracking-[-0.05em] text-white">
                Build your project.
                <br />
                Own the journey.
              </h1>
              <p className="rise mt-6 max-w-lg text-[15px] leading-8 text-white/85 md:text-base">
                把一个想法，做成完整的毕业设计。规划、写作、资料与答辩材料连接在同一个工作区，每一步都有
                AI 协作，也始终由你掌控。
              </p>
              <div className="rise mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href={destination}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-7 text-[15px] font-medium text-neutral-900 transition-opacity hover:opacity-90"
                >
                  {session?.user ? "继续我的项目" : "开始创建项目"}
                  <span aria-hidden="true">→</span>
                </Link>
                <Link
                  href="#features"
                  className="inline-flex h-12 items-center justify-center rounded-full border border-white/60 bg-white/10 px-7 text-[15px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                >
                  了解核心能力
                </Link>
              </div>
              <p className="rise mt-8 text-sm text-white/70">
                <span className="font-mono">10</span> 个阶段 ·{" "}
                <span className="font-mono">1</span> 个工作区 · AI 全程协作
              </p>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-5 flex justify-center text-white/70"
          >
            <ChevronRightIcon className="h-5 w-5 rotate-90 animate-bounce" />
          </div>
        </section>
        {/* 内容雪橇:毛玻璃面板浮在全局背景上,圆角顶部收尾 Hero */}
        <div className="relative rounded-t-[2.5rem] bg-background/85 backdrop-blur-xl">
          <section id="features" className="landing-shell pt-16 pb-20 lg:pt-20 lg:pb-24">
            <p className="eyebrow">
              <span className="text-foreground/50">01</span> / CORE CAPABILITIES
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight">
              毕业设计的每一步，都有对应的支持。
            </h2>
            <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4 lg:gap-0 lg:divide-x lg:divide-line">
              {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
                <div key={title} className="lg:px-8 lg:first:pl-0 lg:last:pr-0">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-foreground/5">
                    <Icon />
                  </span>
                  <p className="mt-5 text-[15px] font-medium">{title}</p>
                  <p className="mt-2 text-sm leading-7 text-muted">{text}</p>
                </div>
              ))}
            </div>
          </section>
          <section id="workflow" className="border-y border-line py-20 lg:py-24">
            <div className="landing-shell grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <div>
                <p className="eyebrow">
                  <span className="text-foreground/50">02</span> / THE PROJECT JOURNEY
                </p>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight">
                  一套流程，贯穿始终。
                </h2>
                <p className="mt-4 max-w-sm text-sm leading-7 text-muted">
                  从选题到答辩共十个阶段，按顺序推进，也可以随时回访。运行预览、自动开发与版本管理作为工具贯穿全过程。
                </p>
                <Link
                  href={destination}
                  className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-85"
                >
                  开始创建项目
                  <span aria-hidden="true">→</span>
                </Link>
              </div>
              <ol className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                {PROJECT_STAGES.map((stage, index) => (
                  <li
                    key={stage}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-3.5"
                  >
                    <span className="font-mono text-xs text-muted">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-sm font-medium">{STAGE_LABELS[stage]}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
          <section id="faq" className="landing-shell py-20 lg:py-24">
            <p className="eyebrow">
              <span className="text-foreground/50">03</span> / FAQ
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight">常见问题</h2>
            <div className="mt-10 border-t border-line">
              {FAQS.map((item) => (
                <details key={item.q} className="group border-b border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <PlusIcon className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-open:rotate-45" />
                  </summary>
                  <p className="max-w-2xl pb-5 text-sm leading-7 text-muted">{item.a}</p>
                </details>
              ))}
            </div>
          </section>
          <section className="landing-shell pb-24 pt-4 text-center lg:pb-32">
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              把想法，做成毕业设计。
            </h2>
            <p className="mt-4 text-sm text-muted md:text-base">
              现在开始，一步一步来。
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                href={destination}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-foreground px-7 text-[15px] font-medium text-background transition-opacity hover:opacity-85"
              >
                {session?.user ? "进入工作台" : "开始创建项目"}
                <span aria-hidden="true">→</span>
              </Link>
              <a
                href="#faq"
                className="inline-flex h-12 items-center justify-center rounded-full border border-line px-7 text-[15px] font-medium transition-colors hover:border-foreground/40"
              >
                了解更多
              </a>
            </div>
          </section>
          <footer className="border-t border-line">
            <div className="landing-shell flex flex-wrap items-center justify-between gap-4 py-8 text-xs text-muted">
              <p>© 2026 GraduateStudio · AI 毕业设计工作台</p>
              <nav className="flex flex-wrap items-center gap-5" aria-label="页脚导航">
                <a href="#features" className="transition-colors hover:text-foreground">
                  核心能力
                </a>
                <a href="#workflow" className="transition-colors hover:text-foreground">
                  项目流程
                </a>
                <a href="#faq" className="transition-colors hover:text-foreground">
                  常见问题
                </a>
                <a
                  href="https://sevnai.site"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono tracking-wide transition-colors hover:text-foreground"
                >
                  SEVN AILAB ↗
                </a>
              </nav>
            </div>
          </footer>
        </div>
      </main>
    </div>
  );
}
