import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { generateErDiagramSvg, ErDiagramError } from "@/server/er-diagram";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Chen 模型 ER 图(sql2er CLI 生成 SVG)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const result = await generateErDiagramSvg(id, session.user.id);
    if (!result) {
      return NextResponse.json({ svg: null });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ErDiagramError) {
      const status = error.code === "er_not_configured" ? 501 : 500;
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return handleRouteError("er-diagram.get", error);
  }
}
