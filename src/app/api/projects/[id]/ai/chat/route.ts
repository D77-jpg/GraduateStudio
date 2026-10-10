import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { streamChat } from "@/server/agents/coding-agent";
import { logActivity } from "@/server/activity";
import { createSSEWriter, sseResponse } from "@/server/realtime/sse";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI 聊天(SSE 流式):event=reasoning|delta|done|error */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const body = (await request.json()) as { message?: string; selectedFilePaths?: string[] };
    const message = (body.message ?? "").trim();
    if (message.length < 1) return jsonError(400, "invalid_input", "消息不能为空");

    const writer = createSSEWriter({ heartbeatMs: 0 });
    void logActivity(id, "ai", `AI 对话:${message.slice(0, 100)}`);

    void (async () => {
      try {
        const stream = await streamChat({
          projectId: id,
          userId: session.user.id,
          message,
          selectedFilePaths: Array.isArray(body.selectedFilePaths)
            ? body.selectedFilePaths.slice(0, 5)
            : [],
        });
        for await (const part of stream.fullStream) {
          if (part.type === "reasoning-delta") {
            writer.send("reasoning", part.text);
          } else if (part.type === "text-delta") {
            writer.send("delta", part.text);
          } else if (part.type === "error") {
            writer.send(
              "error",
              part.error instanceof Error ? part.error.message : String(part.error),
            );
          }
        }
        writer.send("done", {});
      } catch (error) {
        writer.send("error", error instanceof Error ? error.message : "AI 调用失败");
      } finally {
        writer.close();
      }
    })();

    return sseResponse(writer.stream);
  } catch (error) {
    return handleRouteError("agent.chat", error);
  }
}
