import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { getAiStatus } from "@/server/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  let database = false;
  try {
    await db.$queryRaw`SELECT 1`;
    database = true;
  } catch {
    database = false;
  }

  return NextResponse.json({
    status: database ? "ok" : "degraded",
    database,
    ai: getAiStatus(),
    time: new Date().toISOString(),
  });
}
