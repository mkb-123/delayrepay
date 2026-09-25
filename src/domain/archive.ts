import type { Assessment, RailService } from "./types";
export interface StoredService {
  service: RailService;
  assessment: Assessment;
  firstCollectedAt: string;
  assessedAt: string;
  revisions: { assessedAt: string; assessment: Assessment }[];
}
export interface RunRecord {
  id: string; serviceDate: string; startedAt: string; finishedAt: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED"; servicesUpdated: number; message: string;
}
export interface Archive {
  schemaVersion: 1;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  services: StoredService[];
  runs: RunRecord[];
}
export const emptyArchive = (): Archive => ({
  schemaVersion: 1, lastAttemptAt: null, lastSuccessfulAt: null, services: [], runs: [],
});
