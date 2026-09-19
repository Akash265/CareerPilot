import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { createDbClient, closeDbClient, withUserContext, schema } from "@ai-career/db";
import {
  extractCareerGoal,
  createAnthropicClient,
  parseSalaryFloor,
  CareerGoalExtractionValidationError,
  type CareerGoalExtractionDraft,
} from "@ai-career/ai";

const MAX_RAW_TEXT_LENGTH = 4000;

async function extractWithRetry(
  anthropic: ReturnType<typeof createAnthropicClient>,
  env: Parameters<typeof extractCareerGoal>[1],
  text: string
): Promise<CareerGoalExtractionDraft> {
  try {
    return await extractCareerGoal(anthropic, env, text);
  } catch (error) {
    if (error instanceof CareerGoalExtractionValidationError) {
      return await extractCareerGoal(anthropic, env, text);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const rawInput =
    jsonBody.body !== null && typeof jsonBody.body === "object"
      ? (jsonBody.body as { rawText?: unknown }).rawText
      : undefined;
  const rawText = typeof rawInput === "string" ? rawInput.trim() : "";

  if (rawText === "") {
    return NextResponse.json({ error: "Career goal statement cannot be empty" }, { status: 400 });
  }
  if (rawText.length > MAX_RAW_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Career goal statement exceeds ${MAX_RAW_TEXT_LENGTH} characters` },
      { status: 400 }
    );
  }

  const db = createDbClient(env);
  try {
    const goal = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const existing = await tx
        .select({ version: schema.careerGoals.version })
        .from(schema.careerGoals)
        .orderBy(desc(schema.careerGoals.version))
        .limit(1);
      const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

      const [row] = await tx
        .insert(schema.careerGoals)
        .values({ rawText, version: nextVersion, parseStatus: "pending" })
        .returning({ id: schema.careerGoals.id, version: schema.careerGoals.version });
      return row;
    });

    const anthropic = createAnthropicClient(env);
    let extracted: CareerGoalExtractionDraft;
    try {
      extracted = await extractWithRetry(anthropic, env, rawText);
    } catch (error) {
      const message =
        error instanceof CareerGoalExtractionValidationError ? error.message : "Extraction failed";
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
        tx
          .update(schema.careerGoals)
          .set({ parseStatus: "failed", parseError: message })
          .where(eq(schema.careerGoals.id, goal.id))
      );
      return NextResponse.json(
        { goalId: goal.id, version: goal.version, status: "failed", error: message },
        { status: 200 }
      );
    }

    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .update(schema.careerGoals)
        .set({ parseStatus: "parsed" })
        .where(eq(schema.careerGoals.id, goal.id))
    );

    const salary = parseSalaryFloor(extracted.salaryFloorRaw);
    const draft = {
      ...extracted,
      salaryFloorNormalized: salary.amount,
      salaryCurrency: salary.currency,
      salaryIsParsed: salary.isParsed,
    };

    return NextResponse.json({
      goalId: goal.id,
      version: goal.version,
      rawText,
      status: "parsed",
      draft,
    });
  } finally {
    await closeDbClient(db);
  }
}
