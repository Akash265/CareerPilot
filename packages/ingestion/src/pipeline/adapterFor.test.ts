import { describe, it, expect } from "vitest";
import { createAdapterFor, providerConfigFromEnv } from "./adapterFor";
import { BOARD_KINDS, SEARCH_KINDS, type SourceKind } from "../types";

const ENV = {
  GREENHOUSE_API_BASE: "https://gh.test", LEVER_API_BASE: "https://lever.test", ASHBY_API_BASE: "https://ashby.test",
  WORKABLE_API_BASE: "https://workable.test", SMARTRECRUITERS_API_BASE: "https://sr.test", RECRUITEE_API_BASE: "https://{slug}.recruitee.test",
  ADZUNA_API_BASE: "https://adzuna.test", JOOBLE_API_BASE: "https://jooble.test", USAJOBS_API_BASE: "https://usajobs.test",
  THEMUSE_API_BASE: "https://muse.test", REMOTIVE_API_BASE: "https://remotive.test", REMOTEOK_API_BASE: "https://remoteok.test",
  ARBEITNOW_API_BASE: "https://arbeitnow.test", HN_API_BASE: "https://hn.test",
  ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key", ADZUNA_COUNTRIES: ["gb"], JOOBLE_API_KEY: undefined,
  USAJOBS_API_KEY: undefined, USAJOBS_USER_AGENT: undefined,
};

describe("createAdapterFor (Phase 12)", () => {
  it("maps every env base and key into the provider config", () => {
    const p = providerConfigFromEnv(ENV);
    expect(p.boards).toEqual({
      greenhouse: "https://gh.test", lever: "https://lever.test", ashby: "https://ashby.test", workable: "https://workable.test",
      smartrecruiters: "https://sr.test", recruiteeTemplate: "https://{slug}.recruitee.test",
    });
    expect(p.search.bases.hn_hiring).toBe("https://hn.test");
    expect(p.search.keys).toEqual({ adzunaAppId: "id", adzunaAppKey: "key", adzunaCountries: ["gb"], joobleKey: undefined, usajobsKey: undefined, usajobsUserAgent: undefined });
  });

  it("has an adapter for every source kind", () => {
    const adapterFor = createAdapterFor({ db: {} as never, userId: "u", providers: providerConfigFromEnv(ENV) });
    for (const kind of [...BOARD_KINDS, ...SEARCH_KINDS, "upload"] as SourceKind[]) {
      expect(typeof adapterFor({ id: "s", kind, label: kind, config: {} }).fetch, kind).toBe("function");
    }
  });
});
