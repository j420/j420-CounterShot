import { z } from "zod";
export const DOMAIN_SCHEMA_VERSION = "3";

// Model output schemas are deliberately shallow, closed and fully required.
// Schema acceptance is a syntax gate; checkDesign owns physical consistency.
const dimension = z.number().finite().positive().max(2000);
const text = z.string().max(4000);
const identifier = z.string().min(1).max(100);
export const OperationSchema = z.enum(["take", "position", "load", "fold", "close", "release", "reset"]);

export const LegacyFactsSchema = z.object({
  workflow: z.enum(["carton_packing", "electronics_kit"]),
  itemLengthMm: dimension.nullable(),
  itemWidthMm: dimension.nullable(),
  itemHeightMm: dimension.nullable(),
  cartonLengthMm: dimension,
  cartonWidthMm: dimension,
  cartonOuterLengthMm: dimension,
  cartonOuterWidthMm: dimension,
  cartonHeightMm: dimension,
  boardThicknessMm: z.number().finite().positive().max(10),
  sheetWidthMm: dimension,
  sheetHeightMm: dimension,
  slotClearanceMm: z.number().finite().min(0).max(10),
  foldAllowanceMm: z.number().finite().min(-10).max(10),
  workspaceWidthMm: dimension,
  workspaceDepthMm: dimension,
  reachWidthMm: dimension,
  reachDepthMm: dimension,
  activeHand: z.enum(["left", "right"]),
  allowedOperations: z.array(OperationSchema).min(1).max(8),
  kitComponents: z.array(z.object({
    id: z.enum(["screws", "washers", "spacers", "grommets"]),
    label: z.string().min(1).max(120),
    requiredCount: z.number().int().min(1).max(8),
    bundleLengthMm: dimension,
    bundleWidthMm: dimension,
    bundleHeightMm: dimension,
  }).strict()).max(4),
  allowedBodySupports: text,
  closure: z.string().min(1).max(1000),
  notes: text,
}).strict();
export type LegacyFacts = z.infer<typeof LegacyFactsSchema>;

export const LegacyActionSchema = z.object({
  id: identifier,
  label: z.string().min(1).max(1000),
  objectId: identifier,
  operation: OperationSchema,
  dependsOn: z.array(identifier).max(40),
  hand: z.enum(["active", "none"]),
  holdAfter: identifier.nullable(),
  supportAfter: identifier.nullable(),
  xMm: z.number().finite().min(0).max(2000),
  yMm: z.number().finite().min(0).max(2000),
  quantity: z.number().int().min(1).max(8).nullable(),
  compartmentId: identifier.nullable(),
}).strict();
export type LegacyAction = z.infer<typeof LegacyActionSchema>;
export type Action = LegacyAction;

export const LegacyProgramSchema = z.object({
  strategy: z.enum(["corner_stops", "side_rails"]),
  insertClearanceMm: z.number().finite().min(0).max(30),
  wallHeightMm: z.number().finite().positive().max(150),
  stopHeightMm: z.number().finite().positive().max(150),
  offsetXMm: z.number().finite().min(0).max(2000),
  offsetYMm: z.number().finite().min(0).max(2000),
  kitLayout: z.object({
    columns: z.literal(2),
    cellOrder: z.array(z.enum(["screws", "washers", "spacers", "grommets"])).length(4),
    cellClearanceMm: z.number().finite().min(0).max(20),
    dividerHeightMm: z.number().finite().positive().max(100),
  }).strict().nullable(),
}).strict();

export const LegacyProposalSchema = z.object({
  outcome: z.enum(["candidate", "simpler_aid_sufficient", "needs_measurement", "unsupported"]),
  title: z.string().min(1).max(240),
  summary: text,
  rationale: text,
  missingFacts: z.array(z.string().max(1000)).max(20),
  program: LegacyProgramSchema,
  jigProgram: z.null(),
  actions: z.array(LegacyActionSchema).max(80),
  assumptions: z.array(z.string().max(1000)).max(30),
  changes: z.array(z.string().max(1000)).max(30),
}).strict();
export type LegacyProposal = z.infer<typeof LegacyProposalSchema>;

export const JigOperationSchema = z.enum(["take", "locate", "join", "engage_support", "release_support", "park_support", "extract", "place_finished", "reset"]);
export const WorkshopFactsSchema = z.object({
  workflow: z.literal("workshop_jig"),
  boardThicknessMm: z.number().finite().positive().max(10),
  sheetWidthMm: dimension, sheetHeightMm: dimension,
  slotClearanceMm: z.number().finite().min(0).max(10),
  foldAllowanceMm: z.number().finite().min(-10).max(10),
  workspaceWidthMm: dimension, workspaceDepthMm: dimension,
  reachWidthMm: dimension, reachDepthMm: dimension,
  activeHand: z.enum(["left", "right"]),
  allowedBodySupports: text,
  allowedOperations: z.array(JigOperationSchema).min(1).max(9),
  notes: text,
  workpieceWidthMm: dimension, workpieceDepthMm: dimension, workpieceHeightMm: dimension,
  panelThicknessMm: z.number().finite().positive().max(20),
  jointInsertionMm: z.number().finite().positive().max(100),
  maximumAssemblyLiftMm: z.number().finite().min(0).max(200),
  alignmentToleranceMm: z.number().finite().positive().max(20),
  releaseDirection: z.literal("front"),
  jointFamily: z.literal("low_force_interlocking_panels"),
  completedJointsSelfRetain: z.boolean(),
  jointZones: z.array(z.object({
    edge: z.enum(["left", "right", "rear", "front"]),
    startMm: z.number().finite().min(0).max(2000),
    endMm: dimension,
    bottomMm: z.number().finite().min(0).max(2000),
    topMm: dimension,
  }).strict()).min(4).max(24),
}).strict();
export type WorkshopFacts = z.infer<typeof WorkshopFactsSchema>;

export const JigSupportSchema = z.object({
  id: identifier,
  edge: z.enum(["left", "right", "rear"]),
  startMm: z.number().finite().min(0).max(2000),
  lengthMm: dimension,
  heightMm: z.number().finite().positive().max(200),
  footDepthMm: z.number().finite().positive().max(200),
  role: z.enum(["locate", "brace"]),
}).strict();
export type JigSupport = z.infer<typeof JigSupportSchema>;

export const GateSpecSchema = z.object({
  id: identifier,
  heightMm: z.number().finite().positive().max(200),
  footDepthMm: z.number().finite().positive().max(200),
  parkingXMm: z.number().finite().min(0).max(2000),
  parkingYMm: z.number().finite().min(0).max(2000),
  reliefs: z.array(z.object({
    startMm: z.number().finite().min(0).max(2000),
    lengthMm: dimension,
    depthMm: z.number().finite().positive().max(200),
  }).strict()).max(8),
}).strict();
export type GateSpec = z.infer<typeof GateSpecSchema>;

export const JigActionSchema = z.object({
  id: identifier, label: z.string().min(1).max(1000),
  operation: JigOperationSchema,
  partId: identifier,
  supportIds: z.array(identifier).max(16),
  dependsOn: z.array(identifier).max(48),
  hand: z.enum(["active", "none"]),
  xMm: z.number().finite().min(0).max(2000),
  yMm: z.number().finite().min(0).max(2000),
}).strict();
export type JigAction = z.infer<typeof JigActionSchema>;

export const JigProgramSchema = z.object({
  baseWidthMm: dimension, baseDepthMm: dimension,
  offsetXMm: z.number().finite().min(0).max(2000),
  offsetYMm: z.number().finite().min(0).max(2000),
  registrationClearanceMm: z.number().finite().min(0).max(10),
  supports: z.array(JigSupportSchema).min(3).max(12),
  gate: GateSpecSchema,
  actions: z.array(JigActionSchema).max(48),
}).strict();
export type JigProgram = z.infer<typeof JigProgramSchema>;
export type WorkshopProgram = JigProgram;

// Input profiles are a local union. Provider output retains a strict root object
// rather than an unsupported root anyOf/oneOf schema.
export const FactsSchema = z.union([LegacyFactsSchema, WorkshopFactsSchema]);
export type Facts = z.infer<typeof FactsSchema>;
export const ProposalSchema = LegacyProposalSchema.extend({
  program: LegacyProgramSchema.nullable(),
  jigProgram: JigProgramSchema.nullable(),
}).strict();
export type Proposal = z.infer<typeof ProposalSchema>;
export const ActionSchema = LegacyActionSchema;
export const ProgramSchema = LegacyProgramSchema;

export const ObservationSchema = z.object({
  summary: text,
  entities: z.array(z.object({ id: identifier, label: text, description: text }).strict()).max(40),
  actions: z.array(z.object({
    id: identifier,
    label: text,
    startMs: z.number().finite().min(0).nullable(),
    endMs: z.number().finite().min(0).nullable(),
    support: text,
    uncertain: z.boolean(),
  }).strict()).max(60),
  conflicts: z.array(z.object({ description: text, evidence: text }).strict()).max(20),
  questions: z.array(z.string().max(1000)).max(20),
  evidenceCompleteness: z.enum(["complete", "incomplete"]),
  missingSegments: z.array(z.string().max(1000)).max(20),
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;

export type CheckResult = {
  ruleId: string;
  severity: "error" | "warning" | "trial_required";
  message: string;
  affectedIds: string[];
};

export const SUPPORTED_SUPPORTS = [
  "table", "insert", "carton", "exterior_stop", "station", "supply", "finished_area", "compartment_screws", "compartment_washers", "compartment_spacers", "compartment_grommets",
] as const;

export const KIT_COMPONENT_IDS = ["screws", "washers", "spacers", "grommets"] as const;
export type KitComponentId = typeof KIT_COMPONENT_IDS[number];

/** Explicit migration for pre-workflow carton records; no capability is invented. */
export function upgradeLegacyFacts(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const facts = value as Record<string, unknown>;
  if (facts.workflow === "workshop_jig") return value;
  return { ...facts, workflow: facts.workflow ?? "carton_packing", kitComponents: facts.kitComponents ?? [] };
}

/** Legacy programs/actions have no kit-cell plan or quantity claim. */
export function upgradeLegacyProposal(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const proposal = value as Record<string, unknown>;
  const program = proposal.program;
  if (!program || typeof program !== "object" || Array.isArray(program)) return value;
  const p = program as Record<string, unknown>;
  return { ...proposal, jigProgram: proposal.jigProgram ?? null, program: { ...p, kitLayout: p.kitLayout ?? null },
    actions: Array.isArray(proposal.actions) ? proposal.actions.map(action => {
      if (!action || typeof action !== "object" || Array.isArray(action)) return action;
      const a = action as Record<string, unknown>;
      return { ...a, quantity: a.quantity ?? null, compartmentId: a.compartmentId ?? null };
    }) : proposal.actions,
  };
}

export const PHYSICAL_TESTS = [
  "Load a fresh carton from supply without helper preload.",
  "Exercise the full lid/flap opening and closure without contacting a stop or rail.",
  "Check fit, wall springback, retention and station stability with the actual material.",
  "Remove the finished parcel without trapped fixtures, snagging or an undeclared support.",
  "Reset the station and reach the next unused carton using only declared resources.",
] as const;
