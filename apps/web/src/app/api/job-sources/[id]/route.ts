import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { UpdateJobSourceSchema } from "../../../../lib/job-sources/jobSourceSchemas";
import { serializeSource } from "../../../../lib/job-sources/serializeSource";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handlePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = UpdateJobSourceSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  const { enabled, consentConfirmed } = parsed.data;

  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [source] = await tx.select().from(schema.jobSources).where(eq(schema.jobSources.id, id)).limit(1);
      if (!source) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

      // Phase 12 (D185): a search or discovered source runs under the standing consent, which may have been withdrawn
      // since its own consent was stamped; a discovered one also needs automatic discovery on.
      if (enabled && source.origin !== "manual") {
        const [discovery] = await tx.select().from(schema.discoverySettings).limit(1);
        if (!discovery?.consentedAt) {
          return NextResponse.json({ error: "Give permission for discovery on this page before switching this source on" }, { status: 409 });
        }
        if (source.origin === "discovered" && !discovery.autoDiscover) {
          return NextResponse.json({ error: "Switch on automatic discovery before enabling a discovered board" }, { status: 409 });
        }
      }

      // D3: a source cannot be enabled until the user has confirmed they reviewed its Terms of Service.
      // Once recorded the confirmation stays; disabling and re-enabling does not ask again.
      if (enabled && !source.consentConfirmedAt && consentConfirmed !== true) {
        return NextResponse.json(
          { error: "Confirm that you have reviewed this source's Terms of Service before enabling it" },
          { status: 400 }
        );
      }
      const [updated] = await tx
        .update(schema.jobSources)
        .set({
          enabled,
          consentConfirmedAt: source.consentConfirmedAt ?? (enabled ? new Date() : null),
        })
        .where(eq(schema.jobSources.id, id))
        .returning();
      return NextResponse.json({ source: serializeSource(updated, null) });
    });
  } finally {
    await closeDbClient(db);
  }
}

export const PATCH = withRouteErrors("/api/job-sources/[id]", handlePATCH);
