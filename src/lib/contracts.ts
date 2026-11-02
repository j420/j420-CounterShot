import { z } from "zod";

export const packageFamilies = ["wraparound", "tuck_carton"] as const;
export const phases = [
  "observe",
  "confirm",
  "design",
  "build",
  "test",
] as const;
export type Phase = (typeof phases)[number];

export const constraintsSchema = z.object({
  activeHand: z.enum(["right", "left", "both"]),
  allowedActions: z
    .array(z.enum(["grasp", "press", "pull", "fold", "palm_support"]))
    .min(1),
  workspaceWidthMm: z.number().min(200).max(2000),
  workspaceDepthMm: z.number().min(150).max(1500),
  itemLengthMm: z.number().min(40).max(300),
  itemWidthMm: z.number().min(30).max(220),
  itemHeightMm: z.number().min(1).max(60),
  cardboardThicknessMm: z.number().min(0.4).max(6),
  sheetWidthMm: z.number().min(150).max(2000),
  sheetHeightMm: z.number().min(150).max(2000),
  packageFamily: z.enum(packageFamilies),
  cartonLengthMm: z.number().min(40).max(600).nullable(),
  cartonWidthMm: z.number().min(30).max(500).nullable(),
  cartonHeightMm: z.number().min(10).max(250).nullable(),
  measurementsConfirmed: z.literal(true),
  notes: z.string().max(2000),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const observationSchema = z.object({
  summary: z.string().max(2000),
  objects: z
    .array(
      z.object({ name: z.string(), role: z.string(), evidence: z.string() }),
    )
    .max(20),
  actions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        holdingRequirement: z.string(),
        activeManipulation: z.string(),
        evidence: z.string(),
      }),
    )
    .min(1)
    .max(20),
  conflicts: z
    .array(z.object({ actionId: z.string(), description: z.string() }))
    .max(15),
  questions: z.array(z.string()).max(10),
  cycleCoverage: z.object({
    preparation: z.boolean(),
    loading: z.boolean(),
    closure: z.boolean(),
    release: z.boolean(),
    reset: z.boolean(),
  }),
});
export type Observation = z.infer<typeof observationSchema>;

export const supportSchema = z.object({
  objectId: z.string().max(80),
  provider: z.enum(["right_hand", "left_hand", "table", "insert", "station"]),
  role: z.enum(["weight", "resist_push", "locate", "hold_open", "retain"]),
});
export const planStepSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(120),
  instruction: z.string().max(700),
  operation: z.enum([
    "prepare",
    "position",
    "load",
    "fold",
    "retain",
    "close",
    "release",
    "reset",
  ]),
  dependsOn: z.array(z.string()).max(15),
  activeHand: z.enum(["right", "left", "both", "none"]),
  activeObjectId: z.string().max(80),
  supportsDuring: z.array(supportSchema).max(10),
  supportChangesAfter: z.array(supportSchema).max(10),
  releaseObjectsAfter: z.array(z.string()).max(10),
  xMm: z.number(),
  yMm: z.number(),
  physicalAssumptions: z.array(z.string()).max(8),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const proposalSchema = z.object({
  title: z.string().max(160),
  summary: z.string().max(2000),
  originalConflict: z.string().max(1000),
  packageFamily: z.enum(packageFamilies),
  arrangement: z.enum(["corner_nest", "side_guides", "flap_parking"]),
  insert: z.enum(["none", "flat", "tray"]),
  orientation: z.enum(["landscape", "portrait"]),
  clearanceMm: z.number().min(1).max(12),
  insertWallHeightMm: z.number().min(0).max(40),
  stopHeightMm: z.number().min(5).max(60),
  stationXMm: z.number().min(0).max(1800),
  stationYMm: z.number().min(0).max(1300),
  steps: z.array(planStepSchema).min(5).max(18),
  changes: z
    .array(
      z.object({
        layer: z.enum(["package", "workspace", "sequence"]),
        change: z.string(),
        reason: z.string(),
      }),
    )
    .min(1)
    .max(12),
  assumptions: z.array(z.string()).max(12),
  materials: z.array(z.string()).max(12),
  nextTest: z.string().max(1000),
  simplerAlternative: z.string().max(1200),
});
export type Proposal = z.infer<typeof proposalSchema>;

export interface Issue {
  rule: string;
  severity: "error" | "warning" | "trial_required";
  message: string;
  actionId?: string;
}
export interface CheckReport {
  valid: boolean;
  issues: Issue[];
}
export interface Drawing {
  id: string;
  title: string;
  widthMm: number;
  heightMm: number;
  svg: string;
  purpose: string;
}
export interface CompiledDesign {
  drawings: Drawing[];
  cutList: {
    part: string;
    quantity: number;
    widthMm: number;
    heightMm: number;
    material: string;
  }[];
  sharedDimensions: {
    insertLengthMm: number;
    insertWidthMm: number;
    packageLengthMm: number;
    packageWidthMm: number;
    stationWidthMm: number;
    stationDepthMm: number;
  };
  report: CheckReport;
  assembly: string[];
}
export interface Asset {
  id: string;
  filename: string;
  mime: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  kind: "image" | "video";
  role: "job" | "trial";
}
export interface InputSnapshot {
  id: string;
  hash: string;
  constraints: Constraints;
  observation: Observation | null;
  createdAt: string;
}
export interface DesignRevision {
  id: string;
  number: number;
  parentId: string | null;
  inputSnapshotId: string;
  inputHash: string;
  createdAt: string;
  proposal: Proposal;
  compiled: CompiledDesign;
  sourceTrialId: string | null;
  model: string;
  responseId: string | null;
}
export const trialInputSchema = z.object({
  designId: z.string(),
  buildConfirmed: z.boolean(),
  scaleConfirmed: z.boolean(),
  materialMatches: z.boolean(),
  contentsCorrect: z.boolean(),
  closureComplete: z.boolean(),
  parcelReleased: z.boolean(),
  stationReset: z.boolean(),
  freshPackageStarted: z.boolean(),
  evidenceComplete: z.boolean(),
  helperInterventions: z.number().int().min(0).max(100),
  durationSeconds: z.number().min(0).max(7200).nullable(),
  notes: z.string().max(3000),
  assetIds: z.array(z.string()).max(8),
});
export type TrialInput = z.infer<typeof trialInputSchema>;
export interface Trial extends TrialInput {
  id: string;
  createdAt: string;
  outcome: "observed_complete" | "failed" | "incomplete";
}
export interface Job {
  id: string;
  projectId: string;
  kind: "observe" | "design" | "revise";
  status: "queued" | "running" | "succeeded" | "failed" | "superseded";
  stage: string;
  inputHash: string;
  operationId: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  resultId: string | null;
}
export interface Project {
  id: string;
  version: number;
  title: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  observation: Observation | null;
  observationAssetId: string | null;
  snapshots: InputSnapshot[];
  currentSnapshotId: string | null;
  designs: DesignRevision[];
  currentDesignId: string | null;
  trials: Trial[];
}
export interface ProjectSummary {
  id: string;
  title: string;
  goal: string;
  updatedAt: string;
  designCount: number;
  trialCount: number;
}
export interface Health {
  configured: boolean;
  model: string;
  authenticated: boolean;
  accessRequired: boolean;
}
export interface ApiError {
  error: { code: string; message: string; retryable?: boolean };
}
