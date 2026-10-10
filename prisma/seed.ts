import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const DEMO_EMAIL = "demo@graduatestudio.dev";

const DEMO_PROJECTS = [
  {
    name: "AI 智能校园二手交易平台",
    description: "基于协同过滤推荐算法的校园二手交易平台,支持商品发布、智能推荐与站内交易。",
    type: "web",
    techStack: ["Vue 3", "Spring Boot", "MySQL", "Redis"],
    stage: "coding",
    progress: 78,
    daysAgo: 0.1,
  },
  {
    name: "高校实验室预约管理系统",
    description: "面向高校实验室的预约与设备管理系统,包含审批流、权限控制与数据统计。",
    type: "admin",
    techStack: ["React", "NestJS", "MongoDB"],
    stage: "architecture",
    progress: 52,
    daysAgo: 1.4,
  },
  {
    name: "基于深度学习的校园导览小程序",
    description: "利用图像识别实现校园建筑识别与路线导览的微信小程序。",
    type: "miniapp",
    techStack: ["uni-app", "FastAPI", "PostgreSQL"],
    stage: "requirements",
    progress: 35,
    daysAgo: 3.2,
  },
  {
    name: "基于协同过滤的电影推荐系统",
    description: "使用 MovieLens 数据集实现并对比多种协同过滤算法的推荐系统。",
    type: "data",
    techStack: ["Python", "Flask", "MySQL"],
    stage: "topic",
    progress: 8,
    daysAgo: 6.5,
  },
] as const;

async function seedDemoRequirement(userId: string, projectId: string) {
  const existing = await db.requirement.findUnique({ where: { projectId } });
  if (existing) return;

  const modules = [
    {
      name: "用户系统",
      description: "账号与个人信息管理",
      priority: "must",
      features: [
        { name: "注册", description: "学号/邮箱注册", priority: "must" },
        { name: "登录", description: "账号密码登录", priority: "must" },
        { name: "找回密码", description: "邮箱验证码重置", priority: "should" },
        { name: "个人资料", description: "头像、昵称、联系方式维护", priority: "should" },
      ],
    },
    {
      name: "商品系统",
      description: "二手商品的发布与检索",
      priority: "must",
      features: [
        { name: "发布商品", description: "填写标题、描述、价格与图片", priority: "must" },
        { name: "商品搜索", description: "关键词与分类筛选", priority: "must" },
        { name: "商品分类", description: "教材、数码、生活用品等类目", priority: "should" },
        { name: "商品详情", description: "图片轮播、卖家信息、成色说明", priority: "must" },
        { name: "商品收藏", description: "收藏与收藏列表管理", priority: "could" },
      ],
    },
    {
      name: "交易系统",
      description: "下单与订单全流程",
      priority: "must",
      features: [
        { name: "下单", description: "买家对商品发起订单", priority: "must" },
        { name: "订单管理", description: "买卖双方查看与推进订单状态", priority: "must" },
        { name: "模拟支付", description: "校内模拟支付(不对接真实支付)", priority: "should" },
        { name: "售后处理", description: "取消、退货申请与处理", priority: "could" },
      ],
    },
    {
      name: "管理后台",
      description: "平台运营与内容治理",
      priority: "should",
      features: [
        { name: "用户管理", description: "用户列表、封禁与解封", priority: "should" },
        { name: "商品管理", description: "商品审核与违规下架", priority: "should" },
        { name: "订单管理", description: "全平台订单查询与干预", priority: "should" },
        { name: "数据统计", description: "用户/商品/订单趋势图表", priority: "could" },
      ],
    },
  ] as const;

  const requirement = await db.requirement.create({
    data: {
      projectId,
      background:
        "高校学生处置闲置物品的需求持续存在,但现有校园群聊信息零散、缺乏信任保障与统一管理,毕业季闲置物品堆积问题尤为突出。",
      goals: JSON.stringify([
        "为在校学生提供安全、便捷的校园二手交易平台",
        "实现商品发布、检索、收藏的完整信息流程",
        "实现交易订单全流程管理与模拟支付",
        "提供平台运营管理后台与数据统计",
      ]),
      businessFlows: JSON.stringify([
        {
          name: "商品交易流程",
          steps: [
            "买家搜索/浏览商品",
            "查看商品详情",
            "下单并确认订单",
            "模拟支付",
            "卖家确认发货(线下面交/快递)",
            "双方确认完成",
          ],
        },
        {
          name: "商品发布流程",
          steps: [
            "卖家填写商品信息",
            "上传图片与选择分类",
            "提交审核",
            "管理员审核通过",
            "商品上架展示",
          ],
        },
      ]),
      nonFunctional: JSON.stringify([
        "商品列表页在 1000 条数据下加载时间不超过 2 秒",
        "所有接口需要登录鉴权,后台接口需要管理员权限",
        "密码使用 bcrypt 哈希存储,接口参数统一校验防 SQL 注入",
        "核心流程支持移动端浏览器访问",
      ]),
      boundaries: JSON.stringify({
        inScope: ["Web 端买家/卖家/管理员功能", "模拟支付流程", "基于角色的权限控制"],
        outOfScope: ["真实支付对接", "即时聊天(以站内留言代替)", "移动原生 App"],
      }),
      devTasks: JSON.stringify([
        { title: "搭建项目骨架与数据库设计", description: "前后端工程初始化、ER 模型与迁移" },
        { title: "实现用户注册登录与 JWT 鉴权", description: "含密码哈希、路由守卫" },
        { title: "实现商品发布与图片上传", description: "表单校验、分类管理" },
        { title: "实现商品列表/搜索/详情", description: "分页、关键词与分类筛选" },
        { title: "实现订单与模拟支付", description: "订单状态机与支付回调" },
        { title: "实现管理后台", description: "用户/商品/订单管理与统计图表" },
        { title: "系统测试与论文素材整理", description: "接口测试、E2E 流程、截图" },
      ]),
    },
  });

  await db.userRole.createMany({
    data: [
      {
        requirementId: requirement.id,
        name: "学生用户(买家/卖家)",
        description: "发布、浏览、收藏商品并发起交易",
        order: 0,
      },
      {
        requirementId: requirement.id,
        name: "管理员",
        description: "审核商品、管理用户与订单、查看统计数据",
        order: 1,
      },
    ],
  });

  for (const [moduleIndex, module] of modules.entries()) {
    const parent = await db.feature.create({
      data: {
        requirementId: requirement.id,
        name: module.name,
        description: module.description,
        priority: module.priority,
        order: moduleIndex,
      },
    });
    await db.feature.createMany({
      data: module.features.map((feature, featureIndex) => ({
        requirementId: requirement.id,
        parentId: parent.id,
        name: feature.name,
        description: feature.description,
        priority: feature.priority,
        order: featureIndex,
      })),
    });
  }
}

async function main() {
  const passwordHash = await bcrypt.hash("demo1234", 10);
  const user = await db.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: "演示用户",
      passwordHash,
    },
  });

  for (const project of DEMO_PROJECTS) {
    const existing = await db.project.findFirst({
      where: { userId: user.id, name: project.name },
    });
    if (existing) continue;

    const updatedAt = new Date(Date.now() - project.daysAgo * 24 * 60 * 60 * 1000);
    await db.project.create({
      data: {
        userId: user.id,
        name: project.name,
        description: project.description,
        type: project.type,
        techStack: JSON.stringify(project.techStack),
        stage: project.stage,
        progress: project.progress,
        status: "active",
        createdAt: new Date(updatedAt.getTime() - 14 * 24 * 60 * 60 * 1000),
        updatedAt,
      },
    });
  }

  const featured = await db.project.findFirst({
    where: { userId: user.id, name: DEMO_PROJECTS[0].name },
    select: { id: true },
  });
  if (featured) {
    await seedDemoRequirement(user.id, featured.id);
  }

  const count = await db.project.count({ where: { userId: user.id } });
  console.log(`Seed 完成:演示账号 ${DEMO_EMAIL} / demo1234,${count} 个演示项目(含需求分析示例)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
