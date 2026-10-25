import { eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { AppliedBullet } from "@ai-career/resume-optimization";
import {
  TEX_TEMPLATE_VERSION, type DocumentModel, type OmittedItem, type PaperSize, type TailoredResumeDetails,
} from "../model/types";
import type { ResumeProfile } from "../model/resumeProfile";
import { selectTailoredResume, type TailoredSelection } from "../model/selectTailoredResume";
import { normalizeModel } from "../model/normalizeModel";
import { assertSafeModel } from "../model/assertSafeModel";
import { tailoredContentHash } from "../model/hash";
import { buildDownloadFilename } from "../model/filename";
import { findUnsupportedCharacter } from "../render/tex/escapeTex";
import { renderTex } from "../render/tex/renderTex";
import type { TexCompiler } from "../render/compileTex";
import { DocumentExportError, type DocumentExportErrorClass } from "../errors";
import { fitToPage, type FitResult } from "./fitToPage";
import { loadResumeExportContext } from "./loadResumeExportContext";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobRequirements } = schema;

/** A .tex export survives these (it falls back to the estimate, R5); a PDF export cannot. */
const COMPILER_DOWN: ReadonlySet<DocumentExportErrorClass> = new Set(["compiler_unavailable", "compiler_busy", "compiler_timeout"]);

export interface ExportTailoredResumeInput { userId: string; jobId: string; optimizationId: string; format: "pdf" | "tex"; paperSize: PaperSize }
export interface OmittedItemView { sourceType: OmittedItem["sourceType"]; text: string; reason: OmittedItem["reason"] }
export interface TailoredExportResult { document: GeneratedDocumentRow; omittedItems: OmittedItemView[] }

function omittedText(profile: ResumeProfile, item: OmittedItem): string {
  switch (item.sourceType) {
    case "work_experience_bullet":
      return profile.experiences.flatMap((e) => e.bullets).find((b) => b.id === item.sourceFactId)?.text ?? "";
    case "project": {
      const p = profile.projects.find((x) => x.id === item.sourceFactId);
      return p ? `${p.name}: ${p.description}` : "";
    }
    case "achievement":
      return profile.achievements.find((a) => a.id === item.sourceFactId)?.description ?? "";
    case "skill":
      return profile.skills.find((x) => x.id === item.sourceFactId)?.name ?? "";
    case "verified_skill":
      return profile.verifiedSkills.find((x) => x.id === item.sourceFactId)?.term ?? "";
  }
}

/** Phase 13c spec §6: checks → select → whitelist → fit (compile loop) → store, both formats through the same fit. */
export async function exportTailoredResume(
  db: DbClient, storage: Client, compiler: TexCompiler | null, input: ExportTailoredResumeInput
): Promise<TailoredExportResult> {
  if (input.format === "pdf" && compiler === null) throw new DocumentExportError("compiler_unavailable");
  const { job, optimization, profile } = await loadResumeExportContext(db, input);
  const requirements = await withUserContext(db, input.userId, (tx) =>
    tx.select({ termText: jobRequirements.termText, requirementLevel: jobRequirements.requirementLevel })
      .from(jobRequirements).where(eq(jobRequirements.jobId, input.jobId))
  );
  const applied = optimization.selectedBullets as AppliedBullet[];
  const build = (extraRemovals: number, include?: ReadonlySet<string>): TailoredSelection => {
    const selection = selectTailoredResume(profile, applied, requirements, { paperSize: input.paperSize, extraRemovals, include });
    return { ...selection, model: normalizeModel(selection.model) };
  };

  // Later fits only remove items, so checking the first fit covers every model that can be rendered.
  const first = build(0);
  assertSafeModel(first.model);
  const location = findUnsupportedCharacter(first.model);
  if (location !== null) throw new DocumentExportError("unsupported_character", { detail: location });

  const render = (model: DocumentModel) => renderTex(model, { paperSize: input.paperSize });
  let fit: FitResult;
  try {
    fit = await fitToPage(build, render, compiler);
  } catch (err) {
    if (input.format === "tex" && err instanceof DocumentExportError && COMPILER_DOWN.has(err.errorClass)) fit = await fitToPage(build, render, null);
    else throw err;
  }

  const details: TailoredResumeDetails = {
    pageCount: fit.compiled?.pageCount ?? null,
    pageVerified: fit.compiled !== null,
    includedCount: fit.selection.includedCount,
    totalCount: fit.selection.totalCount,
    omitted: fit.selection.omitted,
  };
  let buffer: Buffer;
  if (input.format === "pdf") {
    if (!fit.compiled) throw new Error("a PDF fit always compiles");
    buffer = fit.compiled.pdf;
  } else {
    buffer = Buffer.from(fit.tex, "utf8");
  }
  const document = await storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "tailored_resume",
    format: input.format,
    model: fit.selection.model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "tailored_resume", input.format),
    prerendered: {
      buffer,
      contentHash: tailoredContentHash({ format: input.format, paperSize: input.paperSize, texVersion: fit.compiled?.texVersion ?? null, model: fit.selection.model, details }),
      rendererVersion: `tex-${TEX_TEMPLATE_VERSION}`,
    },
    details,
  });
  return { document, omittedItems: details.omitted.map((o) => ({ sourceType: o.sourceType, text: omittedText(profile, o), reason: o.reason })) };
}
