import { NextResponse } from "next/server";

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

// Route handlers must answer an unparseable body with a 400, not let
// request.json()'s SyntaxError escape as a bare 500.
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }),
    };
  }
}
