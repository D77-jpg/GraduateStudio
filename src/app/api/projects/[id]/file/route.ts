import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { readFileContent } from "@/server/workspace/files";
import { recordManualChange, recordManualDelete } from "@/server/changesets";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 读取文件内容:?path= 相对路径 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const file = readFileContent(id, session.user.id, path);
    return NextResponse.json({ file });
  } catch (error) {
    return handleRouteError("workspace.file.get", error);
  }
}

/** 保存文件(手动编辑留痕)。 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const body = z
      .object({ path: z.string().min(1), content: z.string() })
      .safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "path/content 不合法");

    const changeSet = await recordManualChange({
      projectId: id,
      userId: session.user.id,
      path: body.data.path,
      content: body.data.content,
    });
    return NextResponse.json({ changeSet });
  } catch (error) {
    return handleRouteError("workspace.file.save", error);
  }
}

/** 删除文件(留痕,可撤销)。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const changeSet = await recordManualDelete({
      projectId: id,
      userId: session.user.id,
      path,
    });
    return NextResponse.json({ changeSet });
  } catch (error) {
    return handleRouteError("workspace.file.delete", error);
  }
}
