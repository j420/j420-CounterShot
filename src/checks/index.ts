import { FactsSchema, LegacyFactsSchema, LegacyProposalSchema, ProposalSchema, WorkshopFactsSchema, type Facts, type Proposal, type CheckResult } from "../domain/schema";
import { checkLegacyDesign } from "./legacy";
import { checkWorkshopDesign } from "./workshopJig";
export type { CheckResult } from "../domain/schema";
export const CHECKER_VERSION = "3";

export function checkDesign(facts: Facts, proposal: Proposal): CheckResult[] {
  const f = FactsSchema.safeParse(facts);
  const p = ProposalSchema.safeParse(proposal);
  if (!f.success || !p.success) {
    const errors: CheckResult[] = [];
    for (const result of [f, p]) if (!result.success) for (const issue of result.error.issues) errors.push({ ruleId: "SCHEMA01", severity: "error", message: `${issue.path.join(".")}: ${issue.message}`, affectedIds: [] });
    return errors;
  }
  if (f.data.workflow === "workshop_jig") return checkWorkshopDesign(WorkshopFactsSchema.parse(f.data), p.data);
  const legacy = LegacyProposalSchema.safeParse(p.data);
  if (!legacy.success) return [{ ruleId: "PROFILE01", severity: "error", message: "A carton/kit profile requires its legacy program and no workshop jig program.", affectedIds: [] }];
  return checkLegacyDesign(LegacyFactsSchema.parse(f.data), legacy.data);
}
