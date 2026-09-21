import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../lib/formatValidationError";
import { ListJobsQuerySchema, listJobs } from "../../../lib/jobs/listJobs";

export async function GET(request: Request) {
  const env = loadEnv();
  const parsed = ListJobsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listJobs(tx, parsed.data));
    return NextResponse.json(result);
  } finally {
    await closeDbClient(db);
  }
}
