// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UploadJobsForm } from "./UploadJobsForm";

function mockUploads(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const fn = vi.fn(async (...request: [url: string, init?: RequestInit]) => {
    expect(request[0]).toBe("/api/job-sources/upload");
    const { status, body } = responses[Math.min(call++, responses.length - 1)];
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const fileInput = () => screen.getByLabelText(/Job file/) as HTMLInputElement;
const choose = (name: string) =>
  fireEvent.change(fileInput(), { target: { files: [new File(["title,company\nA,B"], name)] } });
const sentFileName = (fn: ReturnType<typeof mockUploads>, index: number) =>
  (((fn.mock.calls[index][1] as RequestInit).body as FormData).get("file") as File).name;

beforeEach(() => vi.unstubAllGlobals());

describe("UploadJobsForm", () => {
  it("clears the file input after a successful upload so a second file can be uploaded", async () => {
    const fn = mockUploads([{ status: 201, body: { count: 2, queued: true } }]);
    const onUploaded = vi.fn();
    render(<UploadJobsForm onUploaded={onUploaded} />);

    choose("first.csv");
    expect(fileInput().files).toHaveLength(1);
    fireEvent.click(screen.getByLabelText(/permitted to use the data/));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));

    // The input no longer shows the uploaded file, and the form treats it as empty.
    expect(fileInput().files).toHaveLength(0);
    expect(fileInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByText("Select a file first.")).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(1);

    choose("second.csv");
    fireEvent.click(screen.getByLabelText(/permitted to use the data/));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2));

    expect(fn).toHaveBeenCalledTimes(2);
    expect(sentFileName(fn, 0)).toBe("first.csv");
    expect(sentFileName(fn, 1)).toBe("second.csv");
  });

  it("keeps the selected file after a failed upload so it can be retried", async () => {
    const fn = mockUploads([
      { status: 400, body: { error: "File has more than 5,000 rows" } },
      { status: 201, body: { count: 1, queued: true } },
    ]);
    const onUploaded = vi.fn();
    render(<UploadJobsForm onUploaded={onUploaded} />);

    const input = fileInput();
    choose("big.csv");
    fireEvent.click(screen.getByLabelText(/permitted to use the data/));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File has more than 5,000 rows");

    // Same element, still holding the file the user chose.
    expect(fileInput()).toBe(input);
    expect(fileInput().files).toHaveLength(1);
    expect(onUploaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sentFileName(fn, 1)).toBe("big.csv");
  });
});
