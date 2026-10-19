// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "./SkillAnswerForm";

const okFetch = () => {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ verification: {} }) } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
};
beforeEach(() => vi.unstubAllGlobals());
const sent = (fn: ReturnType<typeof vi.fn>) => JSON.parse(fn.mock.calls[0][1].body as string);

describe("SkillAnswerForm", () => {
  it("requires evidence before saving 'I have it'", async () => {
    const fetchFn = okFetch();
    const onSaved = vi.fn();
    render(<SkillAnswerForm termDisplay="Kubernetes" suggestion={null} profileSkills={[]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "I have it" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Where you used Kubernetes"), { target: { value: "Ran our staging cluster." } });
    expect(screen.getByText("24/300")).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchFn.mock.calls[0][0]).toBe("/api/skill-verifications");
    expect(sent(fetchFn)).toEqual({ status: "have", termDisplay: "Kubernetes", evidence: "Ran our staging cluster." });
  });

  it("saves 'I don't have it' in one click and announces the change", async () => {
    const fetchFn = okFetch();
    const listener = vi.fn();
    window.addEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
    render(<SkillAnswerForm termDisplay="dbt" suggestion={null} profileSkills={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "I don't have it" }));
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(sent(fetchFn)).toEqual({ status: "dont_have", termDisplay: "dbt" });
    window.removeEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
  });

  it("pre-selects and labels the suggested profile skill for 'Same as…'", async () => {
    const fetchFn = okFetch();
    render(<SkillAnswerForm termDisplay="PostgreSQL" suggestion="Postgres" profileSkills={["Postgres", "Python"]} onSaved={vi.fn()} />);
    expect(screen.getByText(/suggested: Postgres/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Same as…" }));
    expect(screen.getByLabelText("Same as which of your skills")).toHaveValue("Postgres");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(sent(fetchFn)).toEqual({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "Postgres" });
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "Pick one of your profile skills" }) } as Response));
    render(<SkillAnswerForm termDisplay="MySQL" suggestion={null} profileSkills={["Postgres"]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Same as…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick one of your profile skills");
  });
});
