import type { WorkshopFacts, WorkshopProgram, Proposal } from "../domain/schema";
import type { ConstructionPack } from "./index";

/** This compiler draws the jig only. Workpiece panels/joints are supplied, never invented. */
export const WORKSHOP_COMPILER_VERSION = "3.0.1";

export type JigRect = {
  id: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  zMinMm: number;
  zMaxMm: number;
};
export type JigPoint = { xMm: number; yMm: number };
export type JigBlank = { id: string; label: string; lengthMm: number; widthMm: number; scoreAtMm: number | null };
export type PlacedJigSupport = WorkshopProgram["supports"][number] & {
  footprint: JigRect;
  contact: JigRect;
  blank: JigBlank;
};
export type WorkshopGeometry = {
  base: JigRect;
  workpiece: JigRect;
  gateEngaged: JigRect;
  gateParked: JigRect;
  gateContact: JigRect;
  gateReliefs: { startMm: number; lengthMm: number; depthMm: number; xMm: number; zMinMm: number; zMaxMm: number }[];
  releaseCorridor: JigRect;
  extractedArea: JigRect;
  finishedArea: JigRect;
  supports: PlacedJigSupport[];
  blanks: JigBlank[];
  dimensions: Record<string, number>;
  anchors: {
    baseCenter: JigPoint;
    workpieceCenter: JigPoint;
    gateEngagedCenter: JigPoint;
    gateParkedCenter: JigPoint;
    extractedCenter: JigPoint;
    finishedCenter: JigPoint;
    partTargets: Record<string, JigPoint>;
    supportTargets: Record<string, JigPoint>;
  };
};

// Keep the supplied numbers and arithmetic precision in resolved geometry and
// construction output. Number#toString round-trips the represented JS number;
// these digits describe the design, not measurement or manufacturing accuracy.
const coordinate = (v: number) => String(v);
const labelPosition = (v: number) => Math.round(v * 10) / 10;
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const mm = (v: number) => `${coordinate(v)} mm`;
const center = (rect: JigRect): JigPoint => ({ xMm: rect.xMm + rect.widthMm / 2, yMm: rect.yMm + rect.depthMm / 2 });
const rect = (id: string, x: number, y: number, width: number, depth: number, zMin: number, zMax: number): JigRect => ({
  id, xMm: x, yMm: y, widthMm: width, depthMm: depth, zMinMm: zMin, zMaxMm: zMax,
});

/** Coordinates are millimetres from the front-left workspace corner; +Y is away. */
export function resolveWorkshopGeometry(facts: WorkshopFacts, program: WorkshopProgram): WorkshopGeometry {
  const t = facts.boardThicknessMm;
  const gap = program.registrationClearanceMm;
  const base = rect("jig_base", program.offsetXMm, program.offsetYMm, program.baseWidthMm, program.baseDepthMm, 0, t);
  const workpiece = rect("assembly", base.xMm + (base.widthMm - facts.workpieceWidthMm) / 2,
    base.yMm + (base.depthMm - facts.workpieceDepthMm) / 2,
    facts.workpieceWidthMm, facts.workpieceDepthMm, t, t + facts.workpieceHeightMm);
  const supports: PlacedJigSupport[] = program.supports.map(s => {
    const thick = s.footDepthMm + t;
    let footprint: JigRect;
    let contact: JigRect;
    if (s.edge === "left") {
      footprint = rect(s.id, workpiece.xMm - gap - thick, workpiece.yMm + s.startMm, thick, s.lengthMm, t, t + s.heightMm);
      contact = rect(`${s.id}_contact`, workpiece.xMm - gap - t, workpiece.yMm + s.startMm, t, s.lengthMm, t, t + s.heightMm);
    } else if (s.edge === "right") {
      footprint = rect(s.id, workpiece.xMm + workpiece.widthMm + gap, workpiece.yMm + s.startMm, thick, s.lengthMm, t, t + s.heightMm);
      contact = rect(`${s.id}_contact`, footprint.xMm, footprint.yMm, t, s.lengthMm, t, t + s.heightMm);
    } else {
      footprint = rect(s.id, workpiece.xMm + s.startMm, workpiece.yMm + workpiece.depthMm + gap, s.lengthMm, thick, t, t + s.heightMm);
      contact = rect(`${s.id}_contact`, footprint.xMm, footprint.yMm, s.lengthMm, t, t, t + s.heightMm);
    }
    return { ...s, footprint, contact, blank: {
      id: s.id, label: `${s.edge} ${s.role} strip`, lengthMm: s.lengthMm,
      widthMm: s.footDepthMm + s.heightMm + facts.foldAllowanceMm, scoreAtMm: s.footDepthMm,
    } };
  });
  const gateWidth = workpiece.widthMm + 2 * (gap + t);
  const gateDepth = program.gate.footDepthMm + t;
  const gateEngaged = rect(program.gate.id, workpiece.xMm - gap - t,
    workpiece.yMm - gap - gateDepth, gateWidth, gateDepth, t, t + program.gate.heightMm);
  const gateParked = rect(`${program.gate.id}_parked`, program.gate.parkingXMm, program.gate.parkingYMm,
    gateWidth, gateDepth, t, t + program.gate.heightMm);
  const gateContact = rect(`${program.gate.id}_contact`, gateEngaged.xMm,
    workpiece.yMm - gap - t, gateWidth, t, t, t + program.gate.heightMm);
  const gateReliefs = program.gate.reliefs.map(relief => ({ ...relief,
    xMm: workpiece.xMm + relief.startMm, zMinMm: t + program.gate.heightMm - relief.depthMm,
    zMaxMm: t + program.gate.heightMm,
  }));
  const releaseCorridor = rect("front_release_corridor", workpiece.xMm - gap, 0,
    workpiece.widthMm + 2 * gap, workpiece.yMm, 0, t + facts.workpieceHeightMm);
  const extractedArea = rect("extracted_assembly", workpiece.xMm, workpiece.yMm - workpiece.depthMm - gap,
    workpiece.widthMm, workpiece.depthMm, 0, facts.workpieceHeightMm);
  const finishAction = program.actions.find(a => a.operation === "place_finished" && a.partId === "assembly");
  const finishedArea = rect("finished_output", finishAction ? finishAction.xMm - workpiece.widthMm / 2 : base.xMm + base.widthMm + Math.max(gap, 1),
    finishAction ? finishAction.yMm - workpiece.depthMm / 2 : workpiece.yMm,
    workpiece.widthMm, workpiece.depthMm, 0, facts.workpieceHeightMm);
  const gateBlank: JigBlank = { id: program.gate.id, label: "removable front gate", lengthMm: gateWidth,
    widthMm: program.gate.footDepthMm + program.gate.heightMm + facts.foldAllowanceMm, scoreAtMm: program.gate.footDepthMm };
  const blanks: JigBlank[] = [
    { id: "jig_base", label: "jig base plate", lengthMm: base.widthMm, widthMm: base.depthMm, scoreAtMm: null },
    ...supports.map(s => s.blank), gateBlank,
  ];
  const workpieceCenter = center(workpiece);
  const anchors = {
    baseCenter: center(base), workpieceCenter,
    gateEngagedCenter: center(gateEngaged), gateParkedCenter: center(gateParked),
    extractedCenter: center(extractedArea), finishedCenter: center(finishedArea),
    partTargets: {
      base: workpieceCenter, assembly: workpieceCenter, lid: workpieceCenter,
      left_wall: { xMm: workpiece.xMm, yMm: workpieceCenter.yMm },
      right_wall: { xMm: workpiece.xMm + workpiece.widthMm, yMm: workpieceCenter.yMm },
      rear_wall: { xMm: workpieceCenter.xMm, yMm: workpiece.yMm + workpiece.depthMm },
      front_wall: { xMm: workpieceCenter.xMm, yMm: workpiece.yMm },
      gate: center(gateEngaged),
    },
    supportTargets: Object.fromEntries(supports.map(s => [s.id, center(s.contact)])),
  };
  return { base, workpiece, gateEngaged, gateParked, gateContact, gateReliefs, releaseCorridor, extractedArea, finishedArea, supports, blanks, anchors,
    dimensions: {
      baseWidthMm: base.widthMm, baseDepthMm: base.depthMm, workpieceWidthMm: workpiece.widthMm,
      workpieceDepthMm: workpiece.depthMm, workpieceHeightMm: facts.workpieceHeightMm,
      registrationClearanceMm: gap, gateWidthMm: gateWidth, gateDepthMm: gateDepth,
      gateBlankLengthMm: gateBlank.lengthMm, gateBlankWidthMm: gateBlank.widthMm,
      nominalRequiredAssemblyLiftMm: 0,
      declaredMaximumAssemblyLiftMm: facts.maximumAssemblyLiftMm,
      releaseCorridorWidthMm: releaseCorridor.widthMm, releaseCorridorDepthMm: releaseCorridor.depthMm,
    },
  };
}

function openSvg(width: number, height: number, title: string, hash: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${coordinate(width)}mm" height="${coordinate(height)}mm" viewBox="0 0 ${coordinate(width)} ${coordinate(height)}" role="img" aria-label="${escape(title)}" data-revision="${escape(hash)}" data-compiler="${WORKSHOP_COMPILER_VERSION}"><title>${escape(title)}</title><desc>Deterministic jig drawing. Solid lines cut; amber dashed lines score; cyan lines locate supplied workpieces and are never workpiece manufacturing instructions. Physical admission remains required.</desc><metadata>Exact revision ${escape(hash)}; compiler ${WORKSHOP_COMPILER_VERSION}</metadata><defs><pattern id="jig-hatch" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0,4L4,0" stroke="#b6c3cc" stroke-width=".4"/></pattern></defs><style>text{font:3.2px Arial,sans-serif;fill:#17212b}.title{font-size:5px;font-weight:700}.small{font-size:2.8px}.cut{fill:none;stroke:#17212b;stroke-width:.45}.score{fill:none;stroke:#d97706;stroke-width:.4;stroke-dasharray:3 1.5}.reference{fill:none;stroke:#0891b2;stroke-width:.35;stroke-dasharray:2 2}.support{fill:url(#jig-hatch);stroke:#17212b;stroke-width:.35}.contact{fill:#94a3b8;fill-opacity:.5;stroke:#475569;stroke-width:.3}.corridor{fill:#dcfce7;fill-opacity:.65;stroke:#16a34a;stroke-width:.35;stroke-dasharray:2 2}.ghost{fill:none;stroke:#d97706;stroke-width:.4;stroke-dasharray:3 2}.dim{stroke:#64748b;stroke-width:.25;fill:none}</style><rect width="100%" height="100%" fill="white"/>`;
}
function label(x: number, y: number, value: string, cls = "", centerText = false) {
  return `<text x="${labelPosition(x)}" y="${labelPosition(y)}"${cls ? ` class="${cls}"` : ""}${centerText ? ' text-anchor="middle"' : ""}>${escape(value)}</text>`;
}
function box(x: number, y: number, width: number, height: number, cls: string) {
  return `<rect x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(width)}" height="${coordinate(height)}" class="${cls}"/>`;
}
function line(x1: number, y1: number, x2: number, y2: number, cls: string) {
  return `<line x1="${coordinate(x1)}" y1="${coordinate(y1)}" x2="${coordinate(x2)}" y2="${coordinate(y2)}" class="${cls}"/>`;
}
function rulerX(x: number, y: number, width: number, value = mm(width)) {
  return line(x, y, x + width, y, "dim") + line(x, y - 2, x, y + 2, "dim")
    + line(x + width, y - 2, x + width, y + 2, "dim") + label(x + width / 2, y - 2, value, "small", true);
}
function scaleFooter(x: number, y: number, hash: string) {
  return box(x, y, 50, 50, "cut") + label(x + 25, y + 23, "50 × 50 mm", "", true)
    + label(x + 25, y + 30, "SCALE CHECK", "small", true)
    + label(x + 58, y + 8, "Solid CUT · amber SCORE / FOLD · cyan REFERENCE")
    + label(x + 58, y + 16, "Actual size / 100%. Measure both square edges.")
    + label(x + 58, y + 24, "Oversize: use dimensioned ruler-marking instructions.")
    + label(x + 58, y + 32, "Proposed jig; force, retention and access need trials.", "small")
    + label(x + 58, y + 40, `Revision ${hash.slice(0, 16)}`, "small");
}

export function compileWorkshopDesign(facts: WorkshopFacts, proposal: Proposal, hash: string): ConstructionPack {
  const program = proposal.jigProgram;
  if (proposal.outcome !== "candidate" || !program) throw new Error("A complete workshop jig candidate is required before construction output.");
  const g = resolveWorkshopGeometry(facts, program);
  if (new Set(g.blanks.map(b => b.id)).size !== g.blanks.length) throw new Error("Every jig part must have a unique identity.");
  for (const blank of g.blanks) {
    if (![blank.lengthMm, blank.widthMm].every(v => Number.isFinite(v) && v > 0 && v <= 10000)) {
      throw new Error(`Invalid cut dimensions for ${blank.id}.`);
    }
  }
  const gateWeb = Math.max(3, 2 * facts.boardThicknessMm);
  const reliefs = [...program.gate.reliefs].sort((a, b) => a.startMm - b.startMm);
  for (let i = 0; i < reliefs.length; i++) {
    const relief = reliefs[i];
    if (relief.startMm < 0 || relief.startMm + relief.lengthMm > facts.workpieceWidthMm
      || relief.depthMm <= 0 || program.gate.heightMm - relief.depthMm < gateWeb
      || program.gate.heightMm + facts.foldAllowanceMm - relief.depthMm < gateWeb) {
      throw new Error("Gate relief must preserve the measured-material lower web and stay within the front edge.");
    }
    if (i && relief.startMm - reliefs[i - 1].startMm - reliefs[i - 1].lengthMm < gateWeb) {
      throw new Error("Gate top reliefs must remain disjoint and preserve an intervening material web.");
    }
  }
  const m = 24;
  let cursor = m;
  let parts = "";
  let partsWidth = Math.max(305, program.baseWidthMm + 2 * m);
  for (const blank of g.blanks) {
    parts += label(m, cursor - 12, `${blank.id} / ${blank.label.toUpperCase()}`, "title")
      + label(m, cursor - 5, `Cut ${mm(blank.lengthMm)} × ${mm(blank.widthMm)} · confirmed board ${mm(facts.boardThicknessMm)}`, "small");
    if (blank.id === program.gate.id && program.gate.reliefs.length) {
      const top = cursor + blank.widthMm;
      const points: [number, number][] = [[m, cursor], [m + blank.lengthMm, cursor], [m + blank.lengthMm, top]];
      for (const relief of [...program.gate.reliefs].sort((a, b) => b.startMm - a.startMm)) {
        const start = m + program.registrationClearanceMm + facts.boardThicknessMm + relief.startMm;
        points.push([start + relief.lengthMm, top], [start + relief.lengthMm, top - relief.depthMm],
          [start, top - relief.depthMm], [start, top]);
      }
      points.push([m, top]);
      parts += `<path d="${points.map(([x, y], i) => `${i ? "L" : "M"}${coordinate(x)},${coordinate(y)}`).join(" ")} Z" class="cut"/>`;
    } else parts += box(m, cursor, blank.lengthMm, blank.widthMm, "cut");
    if (blank.scoreAtMm !== null) {
      parts += line(m, cursor + blank.scoreAtMm, m + blank.lengthMm, cursor + blank.scoreAtMm, "score")
        + label(m + blank.lengthMm / 2, cursor + blank.scoreAtMm / 2, blank.id === program.gate.id ? "REMOVABLE LOW-TACK TAPE FOOT" : "EXTERIOR TAPE FOOT", "small", true)
        + label(m + blank.lengthMm / 2, cursor + blank.scoreAtMm + (blank.widthMm - blank.scoreAtMm) / 2,
          blank.id === program.gate.id ? "REMOVABLE GATE / TOP RELIEFS" : "UPRIGHT / OUTSIDE WORKPIECE", "small", true)
        + label(m + blank.lengthMm + 8, cursor + 8, `Score ${mm(blank.scoreAtMm)} from foot edge.`, "small");
    } else {
      const localWork = { x: g.workpiece.xMm - g.base.xMm, y: g.workpiece.yMm - g.base.yMm };
      parts += box(m + localWork.x, cursor + program.baseDepthMm - localWork.y - g.workpiece.depthMm,
        g.workpiece.widthMm, g.workpiece.depthMm, "reference")
        + label(m + blank.lengthMm / 2, cursor + blank.widthMm / 2, "SUPPLIED ENCLOSURE / LOCATION ONLY", "small", true)
        + label(m + blank.lengthMm / 2, cursor + blank.widthMm / 2 + 6, "Do not cut this cyan reference rectangle.", "small", true);
    }
    parts += rulerX(m, cursor + blank.widthMm + 10, blank.lengthMm)
      + label(m + blank.lengthMm + 8, cursor + blank.widthMm / 2, mm(blank.widthMm), "small");
    if (blank.id === program.gate.id) {
      program.gate.reliefs.forEach(relief => {
        parts += label(m, cursor + blank.widthMm + 21,
          `Top relief from workpiece X ${mm(relief.startMm)}: width ${mm(relief.lengthMm)}, depth ${mm(relief.depthMm)}; remaining upright web ${mm(program.gate.heightMm - relief.depthMm)}.`, "small");
        cursor += 7;
      });
    }
    partsWidth = Math.max(partsWidth, blank.lengthMm + 2 * m + 90);
    cursor += blank.widthMm + 46;
  }
  const partsFooter = cursor + 2;
  const partsHeight = partsFooter + 74;
  const packageSvg = openSvg(partsWidth, partsHeight, `${proposal.title} — cardboard jig cut and score parts`, hash)
    + parts + scaleFooter(m, partsFooter, hash) + "</svg>";

  const setupWidth = Math.max(360, facts.workspaceWidthMm + 2 * m);
  const setupBottom = m + facts.workspaceDepthMm;
  const setupFooter = setupBottom + 100 + facts.jointZones.length * 7;
  const setupHeight = setupFooter + 74;
  const projectRect = (rr: JigRect, cls: string) => box(m + rr.xMm, setupBottom - rr.yMm - rr.depthMm, rr.widthMm, rr.depthMm, cls);
  let setup = label(m, 10, "WORKSHOP JIG / ASSEMBLY SETUP", "title")
    + label(m, 17, "Initial state: gate PARKED. Amber ghost = engaged later. All permanent supports stay outside the enclosure.", "small")
    + box(m, m, facts.workspaceWidthMm, facts.workspaceDepthMm, "reference")
    + box(m, setupBottom - facts.reachDepthMm, facts.reachWidthMm, facts.reachDepthMm, "reference")
    + projectRect(g.releaseCorridor, "corridor") + projectRect(g.base, "reference")
    + projectRect(g.workpiece, "reference") + projectRect(g.gateEngaged, "ghost")
    + projectRect(g.finishedArea, "reference")
    + projectRect(g.gateParked, "support")
    + label(m + center(g.workpiece).xMm, setupBottom - center(g.workpiece).yMm - 3, "SUPPLIED ENCLOSURE", "", true)
    + label(m + center(g.workpiece).xMm, setupBottom - center(g.workpiece).yMm + 4,
      `${mm(facts.workpieceWidthMm)} × ${mm(facts.workpieceDepthMm)} × ${mm(facts.workpieceHeightMm)}`, "small", true)
    + label(m + center(g.gateParked).xMm, setupBottom - center(g.gateParked).yMm, `${program.gate.id} / PARKED`, "small", true)
    + label(m + center(g.finishedArea).xMm, setupBottom - center(g.finishedArea).yMm, "FINISHED OUTPUT / KEEP ROUTE CLEAR", "small", true)
    + label(m + center(g.releaseCorridor).xMm, setupBottom - center(g.releaseCorridor).yMm, "FRONT RELEASE / KEEP CLEAR", "small", true);
  for (const support of g.supports) {
    setup += projectRect(support.footprint, "support") + projectRect(support.contact, "contact")
      + label(m + center(support.footprint).xMm, setupBottom - center(support.footprint).yMm,
        `${support.id} / ${support.role}`, "small", true);
  }
  facts.jointZones.forEach((zone, i) => {
    const x1 = zone.edge === "left" ? g.workpiece.xMm : zone.edge === "right" ? g.workpiece.xMm + g.workpiece.widthMm : g.workpiece.xMm + zone.startMm;
    const x2 = zone.edge === "left" || zone.edge === "right" ? x1 : g.workpiece.xMm + zone.endMm;
    const y1 = zone.edge === "front" ? g.workpiece.yMm : zone.edge === "rear" ? g.workpiece.yMm + g.workpiece.depthMm : g.workpiece.yMm + zone.startMm;
    const y2 = zone.edge === "front" || zone.edge === "rear" ? y1 : g.workpiece.yMm + zone.endMm;
    setup += `<line x1="${coordinate(m + x1)}" y1="${coordinate(setupBottom - y1)}" x2="${coordinate(m + x2)}" y2="${coordinate(setupBottom - y2)}" stroke="#dc2626" stroke-width="1"/>`
      + label(m, setupBottom + 66 + i * 7,
        `Joint zone J${i + 1}: ${zone.edge}, along-edge ${mm(zone.startMm)}–${mm(zone.endMm)}, relative height ${mm(zone.bottomMm)}–${mm(zone.topMm)}. Red marks are clearance references.`, "small");
  });
  setup += label(m + 2, setupBottom - 3, "FRONT-LEFT ORIGIN (0,0) · +X right · +Y away", "small")
    + label(m, setupBottom + 14, `Base origin X ${mm(program.offsetXMm)}, Y ${mm(program.offsetYMm)}. Enclosure centred; nominal contact gap ${mm(program.registrationClearanceMm)}.`, "small")
    + label(m, setupBottom + 22, `Gate park origin X ${mm(program.gate.parkingXMm)}, Y ${mm(program.gate.parkingYMm)}; keep its entire foot and upright outside the release route.`, "small")
    + label(m, setupBottom + 30, "Finish joints first; release gate only when the completed assembly demonstrably retains itself. Then park gate and slide FRONT.", "small")
    + label(m, setupBottom + 38, `Nominal jig-required assembly lift: 0 mm. Declared maximum assembly lift ${mm(facts.maximumAssemblyLiftMm)} must be physically verified.`, "small")
    + label(m, setupBottom + 46, `Workpiece family: supplied precut low-force interlocking panels, measured panel ${mm(facts.panelThicknessMm)}, joint insertion ${mm(facts.jointInsertionMm)}.`, "small")
    + label(m, setupBottom + 54, "No panel fabrication CAD is supplied. No strength, insertion-force, self-retention or independent-operation claim is established by this drawing.", "small")
    + scaleFooter(m, setupFooter, hash);
  const stationSvg = openSvg(setupWidth, setupHeight, `${proposal.title} — exterior jig assembly and front release layout`, hash) + setup + "</svg>";

  const instructions = {
    materials: [
      `Supplied precut flatpack instrument-enclosure panels: base, left/right/rear/front walls and lid. Exact measured family: low-force interlocking panels; assembled envelope ${mm(facts.workpieceWidthMm)} × ${mm(facts.workpieceDepthMm)} × ${mm(facts.workpieceHeightMm)}; panel thickness ${mm(facts.panelThicknessMm)}; joint insertion ${mm(facts.jointInsertionMm)}. This pack makes only the cardboard jig, never those panels or joints.`,
      `Confirmed jig board ${mm(facts.boardThicknessMm)} thick; sheet ${mm(facts.sheetWidthMm)} × ${mm(facts.sheetHeightMm)}. Measured clearance coupon ${mm(facts.slotClearanceMm)}, signed fold correction ${mm(facts.foldAllowanceMm)}; model-chosen registration gap ${mm(program.registrationClearanceMm)} must be tested against alignment tolerance ${mm(facts.alignmentToleranceMm)}.`,
      ...g.blanks.map(b => `${b.id}: one ${b.label}, cut ${mm(b.lengthMm)} × ${mm(b.widthMm)}${b.scoreAtMm === null ? "." : `; score ${mm(b.scoreAtMm)} from the foot edge.`}`),
      "Declared tape/connectors, ruler, cutting mat, cutting and scoring tools. Fixed exterior support feet use secure tape; the gate foot uses explicitly removable low-tack tape patches with accessible peel tabs. Tape chemistry, hold and peel forces are unverified.",
    ],
    assembly: [
      `Identify exact revision ${hash}. Print at actual size / 100%, never Fit to page. Measure both sides of the 50 × 50 mm scale square before cutting.`,
      "Drawing coordinates and listed dimensions preserve the design's numeric precision. Extra digits do not establish measurement or manufacturing accuracy; confirm practical accuracy with the measured material and physical trials.",
      "If a drawing exceeds your printer, use the ruler-marking route: mark each listed rectangular blank on the confirmed sheet at its stated dimensions, transfer score offsets and gate relief dimensions. Do not shrink or infer a scale from the screen. Cyan enclosure outlines and layout marks are references, never cut paths for workpieces.",
      `Cut the jig base plate ${mm(program.baseWidthMm)} × ${mm(program.baseDepthMm)}. Mark its front-left origin at workspace X ${mm(program.offsetXMm)}, Y ${mm(program.offsetYMm)}. Mark the supplied enclosure's centred footprint ${mm(facts.workpieceWidthMm)} × ${mm(facts.workpieceDepthMm)}.`,
      ...g.supports.map(s => `Make ${s.id}: cut ${mm(s.blank.lengthMm)} × ${mm(s.blank.widthMm)}, score ${mm(s.footDepthMm)} from one long edge, and fold to an exterior L strip of nominal height ${mm(s.heightMm)}. Position along the ${s.edge} enclosure edge from ${mm(s.startMm)} for ${mm(s.lengthMm)}; contact gap ${mm(program.registrationClearanceMm)}. Its broad foot points OUTWARD. Tape the foot to the base; keep tape and material out of all declared joint zones.`),
      `Make ${program.gate.id}: cut the ${mm(g.dimensions.gateBlankLengthMm)} × ${mm(g.dimensions.gateBlankWidthMm)} removable L-gate blank; score ${mm(program.gate.footDepthMm)} from the front-pointing foot edge. Its upright is nominally ${mm(program.gate.heightMm)} high.`,
      ...program.gate.reliefs.map(relief => `Cut a rectangular TOP-edge gate relief beginning ${mm(program.registrationClearanceMm + facts.boardThicknessMm + relief.startMm)} from the gate blank's left edge: ${mm(relief.lengthMm)} wide × ${mm(relief.depthMm)} deep. Leave ${mm(program.gate.heightMm - relief.depthMm)} of lower upright web. The notch corresponds to workpiece-front X ${mm(relief.startMm)}; actual joint travel and bending still need a trial.`),
      `Initially PARK the gate at X ${mm(program.gate.parkingXMm)}, Y ${mm(program.gate.parkingYMm)}. After locating the supplied base, engage it outside the front edge before joining the front wall, using accessible low-tack tape foot patches. Never tape a workpiece to the gate. No unmeasured slot lock, clamp preload or load rating is assumed.`,
      "Dry-fit the supplied panels and every joint movement against the actual supports and gate notches. Correcting geometry or material creates a new checked revision; do not silently trim a brace or add a clamp. Record maker assistance separately from operating assistance.",
      "The operating plan must complete self-retaining joints before removing gate support. Peel the gate foot's removable patches, withdraw the entire gate and park it clear of the front corridor. Slide the completed assembly forward without lifting it over a wall or trapping a fixture. Reset the gate to PARKED and make fresh panels accessible.",
    ],
    operation: program.actions.map((a, i) => `${i + 1}. ${a.label} [${a.id}; ${a.operation}; ${a.hand === "active" ? facts.activeHand + " hand" : "passive support"}; X ${mm(a.xMm)}, Y ${mm(a.yMm)}; supports ${a.supportIds.join(", ") || "none"}]`),
    tests: [
      "Confirm the actual precut panel/joint subtype, measured outside envelope, insertion travel and joint zones. A familiar interlocking panel is not automatically low-force or self-retaining.",
      "Run a fresh-parts full cycle with the gate initially parked. Observe who holds each panel while the next joint is made; joining cannot invent a free second hand or an undeclared compound grasp.",
      "Test real insertion force, board buckling, stop slip, tape hold, alignment tolerance and joint access. The checker cannot prove force, friction, three-dimensional collision or a human motion path.",
      "Exercise the actual front-panel joints through the gate reliefs. Inspect lower-web strength and springback; a clearance notch is not a strength or retention pass.",
      "Before gate release, inspect that the completed joints actually retain the assembly without a helper or fixture. A declared self-retaining property is still a physical admission requirement.",
      "Peel and remove the gate with the permitted hand, park its complete foot/upright outside the release path, and extract FRONT. Verify actual assembly lift stays within the declared maximum; nominal geometric lift 0 mm is not an observed result.",
      "Check gate tape adhesion over repeated cycles. If patches need renewal, include that actual preparation in reset time and record any assistance; a helper replacing tape between cycles cannot be hidden as independent operation.",
      `Move the extracted enclosure to the separate finished-output area at X ${mm(g.finishedArea.xMm)}, Y ${mm(g.finishedArea.yMm)}, outside the front release corridor. Test the actual transfer path around the parked gate/supports while respecting the maximum assembly lift; static footprints do not prove that motion. Restore gate-PARKED state and access the next set of supplied panels. Record assistance, undeclared body/hand use, drops, failed joints and recording gaps. A human reviewer commits outcomes for this exact jig build/revision.`,
      ...proposal.assumptions.map(a => `Unverified assumption: ${a}`),
    ],
  };
  const list = (items: string[], ordered = false) => `<${ordered ? "ol" : "ul"}>${items.map(item => `<li>${escape(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`;
  const printHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CounterShot workshop jig — ${escape(proposal.title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 24px;color:#17212b}h1{font-size:28px}h2{margin-top:32px}.notice{padding:16px;border:2px solid #d97706;background:#fffbeb}.drawing{overflow:auto;border:1px solid #cbd5e1;margin:24px 0}.drawing svg{display:block;max-width:none;height:auto}li{margin:8px 0}code{word-break:break-all}@page{size:auto;margin:12mm}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}.no-print{display:none}.drawing{overflow:visible;border:0;break-before:page;break-after:page}.drawing svg{max-width:none!important;flex-shrink:0}h2{break-after:avoid}li{break-inside:avoid}}</style></head><body><p class="no-print notice">Print / Save as PDF using the browser menu or Ctrl+P / Cmd+P. Select actual size / 100% and verify the scale square.</p><h1>${escape(proposal.title)}</h1><p>${escape(proposal.summary)}</p><p>Exact revision <code>${escape(hash)}</code> · Workshop compiler ${WORKSHOP_COMPILER_VERSION}</p><div class="notice"><strong>Proposed workshop jig · physical admission required.</strong><p>These files make the jig only. Precut enclosure panels and their real joints are supplied separately. Part drawing sheet ${mm(partsWidth)} × ${mm(partsHeight)}; setup sheet ${mm(setupWidth)} × ${mm(setupHeight)}. Oversize sheets require suitable paper or the dimensioned ruler-marking route. Never shrink to fit. Gate release, front extraction, actual force and joint self-retention require physical tests.</p></div><h2>Materials and supplied workpieces</h2>${list(instructions.materials)}<h2>Build and locate the jig</h2>${list(instructions.assembly, true)}<h2>Full-scale jig cut and score parts</h2><div class="drawing">${packageSvg}</div><h2>Assembly setup and front release</h2><div class="drawing">${stationSvg}</div><h2>Operating sequence</h2>${list(instructions.operation, true)}<h2>Required physical admission tests</h2>${list(instructions.tests)}<p>Supplied facts, model proposals, deterministic checks and observed outcomes remain distinct. No fixture is physically admitted by this drawing alone.</p></body></html>`;
  return { packageSvg, stationSvg, printHtml, instructions, dimensions: g.dimensions };
}
