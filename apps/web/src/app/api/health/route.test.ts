import { describe, it, expect, vi } from "vitest";

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({
    execute: vi.fn().mockResolvedValue([{ ok: 1 }]),
  }),
  closeDbClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("ioredis", () => ({
  default: class {
    async ping() {
      return "PONG";
    }
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns ok when database and redis both respond", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checks: { database: true, redis: true },
    });
  });
});
