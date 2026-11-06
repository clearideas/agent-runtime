/** The showcase gallery, in the order the demos are best explored. */
import { documentLibrary } from "../demos/document-library/host.ts";
import { durableRuns } from "../demos/durable-runs/host.ts";
import { guardrails } from "../demos/guardrails/host.ts";
import { orchestration } from "../demos/orchestration/host.ts";
import { repoMechanic } from "../demos/repo-mechanic/host.ts";
import type { ShowcaseDemo } from "./demo.ts";

export const demos: ShowcaseDemo[] = [
  repoMechanic,
  durableRuns,
  guardrails,
  documentLibrary,
  orchestration,
];

export interface CatalogEntry {
  id: string;
  title: string;
  summary: string;
  tagline: string;
  features: string[];
  status: "ready";
}

export const catalog = (): CatalogEntry[] =>
  demos.map((demo) => ({
    id: demo.id,
    title: demo.title,
    summary: demo.summary,
    tagline: demo.tagline,
    features: demo.features,
    status: "ready",
  }));
