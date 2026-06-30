import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { approveTask } from "@/lib/atelier";

export const dynamic = "force-dynamic";

/**
 * POST /api/approve
 *
 * Two callers, one route:
 *
 *  1. JSON / programmatic clients send `{ "taskId": "..." }` with
 *     `Content-Type: application/json`. We approve the task (proofed|review ->
 *     shipped, writing a dossier_entry(approval) + shipped_at) and return the
 *     shipped task as JSON.
 *
 *  2. The Floor's "Approve" <form> (app/page.tsx) POSTs
 *     `application/x-www-form-urlencoded` with a `taskId` field. We approve,
 *     revalidate "/" so the freshly-shipped task leaves the NEEDS-YOU list, and
 *     redirect back to the Floor.
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  let taskId: string | undefined;

  if (isForm) {
    const form = await request.formData();
    const value = form.get("taskId");
    taskId = typeof value === "string" ? value : undefined;
  } else {
    const body = (await request.json().catch(() => ({}))) as { taskId?: unknown };
    taskId = typeof body.taskId === "string" ? body.taskId : undefined;
  }

  if (!taskId) {
    if (isForm) {
      // Bad form submission — just bounce back to the Floor.
      return NextResponse.redirect(new URL("/", request.url), { status: 303 });
    }
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  try {
    const task = await approveTask(taskId);

    if (isForm) {
      revalidatePath("/");
      return NextResponse.redirect(new URL("/", request.url), { status: 303 });
    }

    return NextResponse.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (isForm) {
      // Surface nothing fancy to the browser — return to the Floor; the task
      // simply stays in NEEDS-YOU if it could not be approved.
      revalidatePath("/");
      return NextResponse.redirect(new URL("/", request.url), { status: 303 });
    }

    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }
}
