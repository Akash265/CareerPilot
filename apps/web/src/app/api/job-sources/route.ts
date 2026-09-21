import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../lib/formatValidationError";
import { isUniqueViolation } from "../../../lib/isUniqueViolation";
import { readJsonBody } from "../../../lib/readJsonBody";
import { CreateJobSourceSchema } from "../../../lib/job-sources/jobSourceSchemas";
import { listJobSourceViews, serializeSource } from "../../../lib/job-sources/serializeSource";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const sources = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listJobSourceViews(tx));
    return NextResponse.json({ sources });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = CreateJobSourceSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  const { kind, slug, companyName } = parsed.data;

  const db = createDbClient(env);
  try {
    // Created disabled and unconsented: enabling is a separate, explicit step that records the
    // Terms-of-Service confirmation (D3).
    const [row] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .insert(schema.jobSources)
        .values({ kind, label: companyName ?? slug, config: { slug, ...(companyName ? { companyName } : {}) } })
        .returning()
    );
    return NextResponse.json({ source: serializeSource(row, null) }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That board is already on your list" }, { status: 409 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
