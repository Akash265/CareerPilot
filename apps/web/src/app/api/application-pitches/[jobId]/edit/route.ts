// apps/web/src/app/api/application-pitches/[jobId]/edit/route.ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createEditedPitch, EditPitchBodySchema, PitchEditError } from "@ai-career/application-package";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { toPitchView } from "../../../../../lib/applicationPitch/serializePitch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = EditPitchBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const pitch = await createEditedPitch(db, env.DEFAULT_USER_ID, jobId, parsed.data);
    return NextResponse.json({ pitch: toPitchView(pitch) }, { status: 201 });
  } catch (error) {
    if (error instanceof PitchEditError) {
      return NextResponse.json({ error: "The version you edited no longer exists for this job" }, { status: 400 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
