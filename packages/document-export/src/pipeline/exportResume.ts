import type { Client } from "minio";
import type { DbClient } from "@ai-career/db";
import type { AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentFormat } from "../model/types";
import { buildResumeModel } from "../model/buildResumeModel";
import { buildDownloadFilename } from "../model/filename";
import { loadResumeExportContext } from "./loadResumeExportContext";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

export interface ExportResumeInput {
  userId: string;
  jobId: string;
  optimizationId: string;
  format: DocumentFormat;
}

/** Phase 7b design §4.4. Refuses (profile_changed) when the profile no longer matches the optimization (D84). */
export async function exportResume(db: DbClient, storage: Client, input: ExportResumeInput): Promise<GeneratedDocumentRow> {
  const { job, optimization, profile } = await loadResumeExportContext(db, input);
  const model = buildResumeModel(profile, optimization.selectedBullets as AppliedBullet[]);
  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "resume",
    format: input.format,
    model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "resume", input.format),
  });
}
