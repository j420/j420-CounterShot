import { LegacyFactsSchema, LegacyProposalSchema, WorkshopFactsSchema, type Facts, type Proposal } from "../domain/schema";
import { compileLegacyDesign, resolveLegacyDimensions, getKitCells as legacyKitCells } from "./legacy";
import { compileWorkshopDesign, resolveWorkshopGeometry } from "./workshopJig";
export type { ConstructionPack, KitCell } from "./legacy";
export { resolveWorkshopGeometry } from "./workshopJig";
export const COMPILER_VERSION = "3.0.2";

export function compileDesign(facts: Facts, proposal: Proposal, revisionHash: string) {
  return facts.workflow === "workshop_jig"
    ? compileWorkshopDesign(WorkshopFactsSchema.parse(facts), proposal, revisionHash)
    : compileLegacyDesign(LegacyFactsSchema.parse(facts), LegacyProposalSchema.parse(proposal), revisionHash);
}
export function resolveDimensions(facts: Facts, proposal: Proposal): Record<string, number> {
  if (facts.workflow === "workshop_jig") {
    if (!proposal.jigProgram) throw new Error("Workshop jig geometry requires its actual program.");
    return resolveWorkshopGeometry(WorkshopFactsSchema.parse(facts), proposal.jigProgram).dimensions;
  }
  return resolveLegacyDimensions(LegacyFactsSchema.parse(facts), LegacyProposalSchema.parse(proposal));
}
export function getKitCells(facts: Facts, proposal: Proposal) {
  if (facts.workflow === "workshop_jig") return [];
  return legacyKitCells(LegacyFactsSchema.parse(facts), LegacyProposalSchema.parse(proposal));
}
