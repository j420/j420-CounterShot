import type { LegacyFacts as Facts, LegacyProposal as Proposal } from "../domain/schema";

export const COMPILER_VERSION = "2.0.1";

/** Repository-owned geometry only. No model-authored paths or markup execute. */
export type ConstructionPack = {
  packageSvg: string;
  stationSvg: string;
  printHtml: string;
  instructions: {
    materials: string[];
    assembly: string[];
    operation: string[];
    tests: string[];
  };
  dimensions: Record<string, number>;
};

// Keep the represented design numbers through calculation and serialization.
// These digits describe geometry, not measurement or manufacturing accuracy.
const coordinate = (value: number) => String(value);
const labelPosition = (value: number) => Math.round(value * 10) / 10;
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));
const mm = (value: number) => `${coordinate(value)} mm`;

export type KitCell = {
  id: string;
  componentId: Facts["kitComponents"][number]["id"];
  label: string;
  requiredCount: number;
  xMm: number;
  yMm: number;
  insideLengthMm: number;
  insideWidthMm: number;
  outerLengthMm: number;
  outerWidthMm: number;
  scoreLengthMm: number;
  scoreWidthMm: number;
  heightMm: number;
  blankLengthMm: number;
  blankWidthMm: number;
  lidDepthMm: number;
  tabWidthMm: number;
  tabDepthMm: number;
  slotWidthMm: number;
  slotHeightMm: number;
  slotFromTopMm: number;
};

/** Each capacity is grounded in a measured FULL required group, never one part times count. */
export function getKitCells(facts: Facts, proposal: Proposal): KitCell[] {
  if (facts.workflow !== "electronics_kit") return [];
  const layout = proposal.program.kitLayout;
  if (!layout) throw new Error("Electronics kit requires an explicit 2 × 2 compartment layout.");
  const ids = ["screws", "washers", "spacers", "grommets"];
  if (facts.kitComponents.length !== 4 || layout.cellOrder.length !== 4 || new Set(layout.cellOrder).size !== 4
    || ids.some(id => !facts.kitComponents.some(c => c.id === id) || !layout.cellOrder.includes(id as typeof layout.cellOrder[number]))) {
    throw new Error("Measure all four component groups and assign each exactly once to the kit grid.");
  }
  const t = facts.boardThicknessMm;
  const f = facts.foldAllowanceMm;
  const minWeb = Math.max(3, 2 * t);
  const cells: KitCell[] = layout.cellOrder.map((componentId, i) => {
    const group = facts.kitComponents.find(c => c.id === componentId)!;
    for (const value of [group.bundleLengthMm, group.bundleWidthMm, group.bundleHeightMm]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Confirm full required-group dimensions for ${componentId}.`);
    }
    const insideLengthMm = group.bundleLengthMm + 2 * layout.cellClearanceMm;
    const insideWidthMm = group.bundleWidthMm + 2 * layout.cellClearanceMm;
    const outerLengthMm = insideLengthMm + 2 * t;
    const outerWidthMm = insideWidthMm + 2 * t;
    const scoreLengthMm = outerLengthMm + 2 * f;
    const scoreWidthMm = outerWidthMm + 2 * f;
    const tabWidthMm = (scoreLengthMm - 2 * minWeb) / 2;
    const slotFromTopMm = layout.dividerHeightMm * .45;
    const tabDepthMm = slotFromTopMm + Math.max(3, t + facts.slotClearanceMm);
    return {
      id: `P02${String.fromCharCode(65 + i)}`, componentId, label: group.label, requiredCount: group.requiredCount,
      xMm: 0, yMm: 0, insideLengthMm, insideWidthMm, outerLengthMm, outerWidthMm,
      scoreLengthMm, scoreWidthMm, heightMm: layout.dividerHeightMm,
      blankLengthMm: scoreLengthMm + 2 * layout.dividerHeightMm,
      blankWidthMm: 2 * scoreWidthMm + 2 * layout.dividerHeightMm + tabDepthMm,
      lidDepthMm: scoreWidthMm, tabWidthMm, tabDepthMm,
      slotWidthMm: tabWidthMm + 2 * facts.slotClearanceMm,
      slotHeightMm: t + facts.slotClearanceMm, slotFromTopMm,
    };
  });
  const colWidths = [Math.max(cells[0].outerLengthMm, cells[2].outerLengthMm), Math.max(cells[1].outerLengthMm, cells[3].outerLengthMm)];
  const rowDepths = [Math.max(cells[0].outerWidthMm, cells[1].outerWidthMm), Math.max(cells[2].outerWidthMm, cells[3].outerWidthMm)];
  return cells.map((cell, i) => ({ ...cell,
    xMm: proposal.program.insertClearanceMm + (i % 2 ? colWidths[0] + facts.slotClearanceMm : 0) + (colWidths[i % 2] - cell.outerLengthMm) / 2,
    yMm: proposal.program.insertClearanceMm + (i > 1 ? rowDepths[0] + facts.slotClearanceMm : 0) + (rowDepths[Math.floor(i / 2)] - cell.outerWidthMm) / 2,
  }));
}

/** Shared dimensions used by the compiler and checker, including all real cut blanks. */
export function resolveLegacyDimensions(facts: Facts, proposal: Proposal): Record<string, number> {
  const p = proposal.program;
  let trayInnerLengthMm: number;
  let trayInnerWidthMm: number;
  const cells = getKitCells(facts, proposal);
  if (facts.workflow === "electronics_kit") {
    trayInnerLengthMm = Math.max(cells[0].outerLengthMm, cells[2].outerLengthMm)
      + Math.max(cells[1].outerLengthMm, cells[3].outerLengthMm) + facts.slotClearanceMm + 2 * p.insertClearanceMm;
    trayInnerWidthMm = Math.max(cells[0].outerWidthMm, cells[1].outerWidthMm)
      + Math.max(cells[2].outerWidthMm, cells[3].outerWidthMm) + facts.slotClearanceMm + 2 * p.insertClearanceMm;
  } else {
    if (facts.itemLengthMm === null || facts.itemWidthMm === null || facts.itemHeightMm === null) {
      throw new Error("Carton packing requires measured item dimensions.");
    }
    trayInnerLengthMm = facts.itemLengthMm + 2 * p.insertClearanceMm;
    trayInnerWidthMm = facts.itemWidthMm + 2 * p.insertClearanceMm;
  }
  const trayOuterLengthMm = trayInnerLengthMm + 2 * facts.boardThicknessMm;
  const trayOuterWidthMm = trayInnerWidthMm + 2 * facts.boardThicknessMm;
  const scoreLengthMm = trayOuterLengthMm + 2 * facts.foldAllowanceMm;
  const scoreWidthMm = trayOuterWidthMm + 2 * facts.foldAllowanceMm;
  const footDepthMm = Math.max(20, p.stopHeightMm);
  const registrationGapMm = facts.slotClearanceMm;
  const guideLengthMm = p.strategy === "side_rails"
    ? facts.cartonOuterLengthMm : Math.min(60, facts.cartonOuterLengthMm / 2, facts.cartonOuterWidthMm / 2);
  const d: Record<string, number> = {
    trayInnerLengthMm, trayInnerWidthMm, trayOuterLengthMm, trayOuterWidthMm, scoreLengthMm, scoreWidthMm,
    blankLengthMm: scoreLengthMm + 2 * p.wallHeightMm, blankWidthMm: scoreWidthMm + 2 * p.wallHeightMm,
    stationLengthMm: facts.cartonOuterLengthMm + 2 * (footDepthMm + registrationGapMm),
    stationWidthMm: facts.cartonOuterWidthMm + 2 * (footDepthMm + registrationGapMm),
    footDepthMm, registrationGapMm, guideLengthMm,
    fixtureBlankLengthMm: guideLengthMm, fixtureBlankWidthMm: footDepthMm + p.stopHeightMm + facts.foldAllowanceMm,
  };
  if (cells.length) {
    d.kitGridLengthMm = trayInnerLengthMm - 2 * p.insertClearanceMm;
    d.kitGridWidthMm = trayInnerWidthMm - 2 * p.insertClearanceMm;
    d.kitCellHeightMm = p.kitLayout!.dividerHeightMm;
    d.kitClosedStackHeightMm = p.kitLayout!.dividerHeightMm + 3 * facts.boardThicknessMm;
    for (const cell of cells) {
      d[`${cell.componentId}BlankLengthMm`] = cell.blankLengthMm;
      d[`${cell.componentId}BlankWidthMm`] = cell.blankWidthMm;
    }
  }
  return d;
}

function svgStart(width: number, height: number, title: string, description: string, revisionHash: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${coordinate(width)}mm" height="${coordinate(height)}mm" viewBox="0 0 ${coordinate(width)} ${coordinate(height)}" role="img" aria-label="${esc(title)}" data-revision="${esc(revisionHash)}"><title>${esc(title)}</title><desc>${esc(description)}</desc><metadata>CounterShot exact revision ${esc(revisionHash)}</metadata><defs><marker id="dimension-arrow" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto-start-reverse"><path d="M0,0 L4,2 L0,4" fill="none" stroke="#64748b" stroke-width=".5"/></marker><pattern id="support-hatch" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0,4 L4,0" stroke="#cbd5e1" stroke-width=".4"/></pattern></defs><style>text{font-family:Arial,sans-serif;fill:#17212b;font-size:3.2px}.title{font-size:5px;font-weight:700}.small{font-size:2.8px}.muted{fill:#64748b}.cut{fill:none;stroke:#17212b;stroke-width:.45}.score{fill:none;stroke:#d97706;stroke-width:.4;stroke-dasharray:3 1.5}.dim{fill:none;stroke:#64748b;stroke-width:.25}.layout{fill:none;stroke:#0891b2;stroke-width:.4;stroke-dasharray:2 2}.support{fill:url(#support-hatch);stroke:#17212b;stroke-width:.3}</style><rect width="100%" height="100%" fill="white"/>`;
}
function text(x: number, y: number, value: string, cls = "", extra = "") {
  return `<text x="${labelPosition(x)}" y="${labelPosition(y)}"${cls ? ` class="${cls}"` : ""}${extra}>${esc(value)}</text>`;
}
function line(x1: number, y1: number, x2: number, y2: number, cls: string) {
  return `<line x1="${coordinate(x1)}" y1="${coordinate(y1)}" x2="${coordinate(x2)}" y2="${coordinate(y2)}" class="${cls}"/>`;
}
function rect(x: number, y: number, width: number, height: number, cls: string, extra = "") {
  return `<rect x="${coordinate(x)}" y="${coordinate(y)}" width="${coordinate(width)}" height="${coordinate(height)}" class="${cls}"${extra}/>`;
}
function dimensionX(x: number, y: number, width: number, label: string) {
  return line(x, y - 3, x, y + 3, "dim") + line(x + width, y - 3, x + width, y + 3, "dim")
    + `<line x1="${coordinate(x + 1)}" y1="${coordinate(y)}" x2="${coordinate(x + width - 1)}" y2="${coordinate(y)}" class="dim" marker-start="url(#dimension-arrow)" marker-end="url(#dimension-arrow)"/>`
    + text(x + width / 2, y - 2, label, "small", ' text-anchor="middle"');
}
function dimensionY(x: number, y: number, height: number, label: string) {
  return line(x - 3, y, x + 3, y, "dim") + line(x - 3, y + height, x + 3, y + height, "dim")
    + `<line x1="${coordinate(x)}" y1="${coordinate(y + 1)}" x2="${coordinate(x)}" y2="${coordinate(y + height - 1)}" class="dim" marker-start="url(#dimension-arrow)" marker-end="url(#dimension-arrow)"/>`
    + `<text x="${coordinate(x - 2)}" y="${coordinate(y + height / 2)}" class="small" text-anchor="middle" transform="rotate(-90 ${coordinate(x - 2)} ${coordinate(y + height / 2)})">${esc(label)}</text>`;
}
function footer(x: number, y: number, hash: string) {
  return rect(x, y, 50, 50, "cut") + text(x + 25, y + 24, "50 × 50 mm", "", ' text-anchor="middle"')
    + text(x + 25, y + 30, "SCALE CHECK", "small", ' text-anchor="middle"')
    + text(x + 58, y + 8, "Solid = CUT · dashed amber = SCORE / FOLD")
    + text(x + 58, y + 16, "Print at actual size / 100%. Measure the square.")
    + text(x + 58, y + 24, "Oversize: use the dimensioned ruler-marking method.")
    + text(x + 58, y + 32, "Proposed geometry. Physical fit and operation are untested.", "small")
    + text(x + 58, y + 40, `Revision ${hash.slice(0, 16)}`, "small")
    + text(x + 58, y + 48, "Digits specify geometry; measure and verify actual part accuracy.", "small");
}

function cellDieline(cell: KitCell, x: number, y: number) {
  const h = cell.heightMm;
  const bx = x + h;
  const by = y + cell.lidDepthMm + h;
  const right = bx + cell.scoreLengthMm;
  const bottom = by + cell.scoreWidthMm;
  const lidTop = y;
  const frontTop = bottom + h;
  const tabLeft = bx + (cell.scoreLengthMm - cell.tabWidthMm) / 2;
  const tabRight = tabLeft + cell.tabWidthMm;
  const taper = Math.min(cell.tabWidthMm / 4, 3);
  const points = [
    [bx, lidTop], [right, lidTop], [right, by - h], [right + h, by - h],
    [right + h, frontTop], [tabRight, frontTop], [tabRight - taper, frontTop + cell.tabDepthMm],
    [tabLeft + taper, frontTop + cell.tabDepthMm], [tabLeft, frontTop],
    [x, frontTop], [x, by - h], [bx, by - h],
  ];
  let out = `<path d="${points.map(([px, py], i) => `${i ? "L" : "M"}${coordinate(px)},${coordinate(py)}`).join(" ")} Z" class="cut"/>`
    + line(bx, by - h, bx, by, "cut") + line(right, by - h, right, by, "cut")
    + line(bx, bottom, bx, bottom + h, "cut") + line(right, bottom, right, bottom + h, "cut")
    + line(x, by, right + h, by, "score") + line(x, bottom, right + h, bottom, "score")
    + line(bx, by, bx, bottom, "score") + line(right, by, right, bottom, "score")
    + line(bx, by - h, right, by - h, "score")
    + line(tabLeft, frontTop, tabRight, frontTop, "score")
    + rect(bx + (cell.scoreLengthMm - cell.slotWidthMm) / 2,
      lidTop + cell.slotFromTopMm - cell.slotHeightMm / 2,
      cell.slotWidthMm, cell.slotHeightMm, "cut")
    + text(bx + cell.scoreLengthMm / 2, by + cell.scoreWidthMm / 2 - 3, cell.id, "title", ' text-anchor="middle"')
    + text(bx + cell.scoreLengthMm / 2, by + cell.scoreWidthMm / 2 + 3, `${cell.label} × ${cell.requiredCount}`, "small", ' text-anchor="middle"')
    + text(bx + cell.scoreLengthMm / 2, lidTop + cell.lidDepthMm / 2, "HINGED LID", "small", ' text-anchor="middle"')
    + text(bx + cell.scoreLengthMm / 2, frontTop + cell.tabDepthMm + 9, `Top lock: front tongue ${mm(cell.tabWidthMm)} × ${mm(cell.tabDepthMm)}; lid slot ${mm(cell.slotWidthMm)} × ${mm(cell.slotHeightMm)}`, "small", ' text-anchor="middle"')
    + dimensionX(x, frontTop + cell.tabDepthMm + 19, cell.blankLengthMm, `Cut envelope ${mm(cell.blankLengthMm)}`)
    + dimensionY(x - 10, y, cell.blankWidthMm, mm(cell.blankWidthMm));
  return out;
}

function kitDielineRows(cells: KitCell[], startY: number) {
  let cursor = startY;
  let fragment = "";
  let width = 285;
  for (const cell of cells) {
    fragment += text(24, cursor, `${cell.id} / ${cell.label.toUpperCase()} × ${cell.requiredCount} — INDEPENDENT CLOSABLE CELL`, "title")
      + text(24, cursor + 7, `Required-group inside ${mm(cell.insideLengthMm)} × ${mm(cell.insideWidthMm)}; wall ${mm(cell.heightMm)}. Make one.`, "small")
      + cellDieline(cell, 24, cursor + 17);
    cursor += cell.blankWidthMm + 60;
    width = Math.max(width, cell.blankLengthMm + 48);
  }
  return { fragment, bottomY: cursor, width };
}

export function compileLegacyDesign(facts: Facts, proposal: Proposal, revisionHash: string): ConstructionPack {
  if (proposal.outcome !== "candidate") throw new Error("Only a candidate can produce construction artifacts.");
  const d = resolveLegacyDimensions(facts, proposal);
  const cells = getKitCells(facts, proposal);
  for (const [key, value] of Object.entries(d)) {
    // Zero calibration gap is meaningful; rendered geometric extents must remain positive.
    const permitsZero = key === "registrationGapMm";
    if (!Number.isFinite(value) || value > 10000 || (permitsZero ? value < 0 : value <= 0)) {
      throw new Error(`Invalid resolved dimension: ${key}`);
    }
  }
  for (const cell of cells) {
    const web = Math.max(3, 2 * facts.boardThicknessMm);
    if (cell.tabWidthMm <= 2 * facts.boardThicknessMm || cell.tabDepthMm >= cell.heightMm
      || cell.slotWidthMm > cell.scoreLengthMm - 2 * web
      || cell.slotFromTopMm - cell.slotHeightMm / 2 < web
      || cell.lidDepthMm - cell.slotFromTopMm - cell.slotHeightMm / 2 < web) {
      throw new Error(`${cell.id}: measured material and chosen cell height do not leave a usable tuck tab / receiving-slot web.`);
    }
  }
  const p = proposal.program;
  const m = 24;
  const w = p.wallHeightMm;
  const bx = m + w;
  const by = m + w;
  const right = bx + d.scoreLengthMm;
  const bottom = by + d.scoreWidthMm;
  const kitRows = cells.length ? kitDielineRows(cells, d.blankWidthMm + 2 * m + 30) : null;
  const packageFooterY = kitRows ? kitRows.bottomY + 4 : d.blankWidthMm + 2 * m + 4;
  const sheetWidth = Math.max(285, d.blankLengthMm + 2 * m, kitRows?.width ?? 0);
  const sheetHeight = packageFooterY + 74;
  let packageSvg = svgStart(sheetWidth, sheetHeight, `${proposal.title} — ${cells.length ? "P01 carrier and P02 cell dielines" : "P01 retaining tray"}`, "Full-scale cut and score tray dieline. Dimensions in millimetres. All performance remains subject to physical tests.", revisionHash);
  packageSvg += text(m, 10, "COUNTERSHOT / P01 RETAINING TRAY", "title")
    + text(m, 17, `Board ${mm(facts.boardThicknessMm)} · coupon fold correction ${mm(facts.foldAllowanceMm)} · ${proposal.title}`, "small")
    + rect(m, m, d.blankLengthMm, d.blankWidthMm, "cut");
  // Four corner tabs remain attached to the short end walls. Only these slits cut inward.
  packageSvg += line(bx, m, bx, by, "cut") + line(right, m, right, by, "cut")
    + line(bx, bottom, bx, m + d.blankWidthMm, "cut")
    + line(right, bottom, right, m + d.blankWidthMm, "cut")
    + line(m, by, m + d.blankLengthMm, by, "score")
    + line(m, bottom, m + d.blankLengthMm, bottom, "score")
    + line(bx, by, bx, bottom, "score") + line(right, by, right, bottom, "score")
    + (cells.length ? "" : text(bx + d.scoreLengthMm / 2, by + d.scoreWidthMm / 2 - 4, "P01 / BASE", "title", ' text-anchor="middle"'))
    + (cells.length ? "" : text(bx + d.scoreLengthMm / 2, by + d.scoreWidthMm / 2 + 4, `Nominal inside ${mm(d.trayInnerLengthMm)} × ${mm(d.trayInnerWidthMm)}`, "", ' text-anchor="middle"'))
    + (cells.length ? "" : text(bx + d.scoreLengthMm / 2, by + d.scoreWidthMm / 2 + 11, `Finished outside ${mm(d.trayOuterLengthMm)} × ${mm(d.trayOuterWidthMm)}`, "small", ' text-anchor="middle"'))
    + text(bx + d.scoreLengthMm / 2, m + w / 2, `WALL ${mm(w)}`, "small", ' text-anchor="middle"')
    + text(bx + d.scoreLengthMm / 2, bottom + w / 2, "TAPE CORNER TABS; KEEP INSIDE CLEAR", "small", ' text-anchor="middle"');
  if (w >= 10) {
    for (const [x, y] of [[m + w / 2, m + w / 2], [right + w / 2, m + w / 2], [m + w / 2, bottom + w / 2], [right + w / 2, bottom + w / 2]]) {
      packageSvg += text(x, y, "TAB", "small", ' text-anchor="middle"');
    }
  }
  for (const cell of cells) {
    const x = bx + facts.boardThicknessMm + cell.xMm;
    const y = by + facts.boardThicknessMm + d.trayInnerWidthMm - cell.yMm - cell.outerWidthMm;
    packageSvg += rect(x, y, cell.outerLengthMm, cell.outerWidthMm, "layout")
      + text(x + cell.outerLengthMm / 2, y + cell.outerWidthMm / 2 - 3, `${cell.id} · ${cell.requiredCount}`, "small", ' text-anchor="middle"')
      + text(x + cell.outerLengthMm / 2, y + cell.outerWidthMm / 2 + 3, cell.label, "small", ' text-anchor="middle"');
  }
  packageSvg += dimensionX(m, m + d.blankWidthMm + 10, d.blankLengthMm, `Cut blank ${mm(d.blankLengthMm)}`)
    + dimensionY(12, m, d.blankWidthMm, `Cut blank ${mm(d.blankWidthMm)}`)
    + dimensionX(bx, by - 3, d.scoreLengthMm, `Score spacing ${mm(d.scoreLengthMm)}`)
    + (kitRows?.fragment ?? "")
    + footer(m, packageFooterY, revisionHash) + "</svg>";

  const workspaceY = m;
  const workspaceBottom = workspaceY + facts.workspaceDepthMm;
  const foot = d.footDepthMm;
  const sx = m + p.offsetXMm;
  const sy = workspaceBottom - p.offsetYMm - d.stationWidthMm;
  const cx = sx + foot + d.registrationGapMm;
  const cy = sy + foot + d.registrationGapMm;
  const fY = workspaceBottom + 48;
  const fixturePanelHeight = d.fixtureBlankWidthMm;
  const stationSheetWidth = Math.max(285, facts.workspaceWidthMm + 2 * m);
  const stationFooterY = fY + fixturePanelHeight + 24;
  const stationSheetHeight = stationFooterY + 70;
  let stationSvg = svgStart(stationSheetWidth, stationSheetHeight, `${proposal.title} — station layout and S01 supports`, "Full-scale exterior stop templates and proposed tabletop layout. Origin is front-left, X right, Y away from operator. Cyan lines are placement references, not cuts.", revisionHash);
  stationSvg += text(m, 10, "COUNTERSHOT / EXTERIOR SUPPORTS", "title")
    + text(m, 17, "Top-opening hinged-lid/tuck carton only. Check every flap, extraction and reset before admission.", "small")
    + rect(m, workspaceY, facts.workspaceWidthMm, facts.workspaceDepthMm, "layout")
    + rect(m, workspaceBottom - facts.reachDepthMm, facts.reachWidthMm, facts.reachDepthMm, "layout", ' fill="#ecfeff" fill-opacity=".5"')
    + rect(sx, sy, d.stationLengthMm, d.stationWidthMm, "layout")
    + rect(cx, cy, facts.cartonOuterLengthMm, facts.cartonOuterWidthMm, "layout")
    + (cells.length ? "" : text(cx + facts.cartonOuterLengthMm / 2, cy + facts.cartonOuterWidthMm / 2, "EXISTING CARTON", "", ' text-anchor="middle"'))
    + (cells.length ? "" : text(cx + facts.cartonOuterLengthMm / 2, cy + facts.cartonOuterWidthMm / 2 + 6, "P01 travels inside finished parcel", "small", ' text-anchor="middle"'))
    + text(m + 2, workspaceBottom - 3, "ORIGIN (0,0) · FRONT LEFT", "small")
    + line(m, workspaceBottom, m + 45, workspaceBottom, "dim")
    + text(m + 47, workspaceBottom + 2, "+X right", "small")
    + line(m, workspaceBottom, m, workspaceBottom - 35, "dim")
    + text(m + 2, workspaceBottom - 36, "+Y away", "small")
    + text(m + facts.reachWidthMm - 2, workspaceBottom - 4, "CONFIRMED REACH RECTANGLE", "small", ' text-anchor="end"');
  for (const cell of cells) {
    const x = cx + (facts.cartonOuterLengthMm - d.trayOuterLengthMm) / 2 + facts.boardThicknessMm + cell.xMm;
    const y = cy + (facts.cartonOuterWidthMm - d.trayOuterWidthMm) / 2 + facts.boardThicknessMm + d.trayInnerWidthMm - cell.yMm - cell.outerWidthMm;
    stationSvg += rect(x, y, cell.outerLengthMm, cell.outerWidthMm, "layout")
      + text(x + cell.outerLengthMm / 2, y + cell.outerWidthMm / 2 - 3, cell.id, "small", ' text-anchor="middle"')
      + text(x + cell.outerLengthMm / 2, y + cell.outerWidthMm / 2 + 3, `${cell.label} × ${cell.requiredCount}`, "small", ' text-anchor="middle"');
  }
  if (p.strategy === "corner_stops") {
    stationSvg += rect(sx, cy + facts.cartonOuterWidthMm - d.guideLengthMm, foot, d.guideLengthMm, "support")
      + rect(cx, sy, d.guideLengthMm, foot, "support")
      + text(sx + 2, cy + facts.cartonOuterWidthMm - d.guideLengthMm - 3, "S01 · left")
      + text(cx, sy - 3, "S02 · rear");
  } else {
    stationSvg += rect(cx, sy, d.guideLengthMm, foot, "support")
      + rect(cx, cy + facts.cartonOuterWidthMm + d.registrationGapMm, d.guideLengthMm, foot, "support")
      + text(cx, sy - 3, "S01 · rear rail")
      + text(cx, cy + facts.cartonOuterWidthMm + foot + 8, "S02 · front rail — verify loading access");
  }
  stationSvg += text(sx, sy + d.stationWidthMm + 8, `Envelope origin X ${mm(p.offsetXMm)} / Y ${mm(p.offsetYMm)}`, "small")
    + dimensionX(m, workspaceBottom + 14, facts.workspaceWidthMm, `Workspace ${mm(facts.workspaceWidthMm)}`)
    + text(m, fY - 14, "S01 + S02 / CUT TWO IDENTICAL L-SECTION STOPS", "title")
    + text(m, fY - 7, `Base foot ${mm(foot)}; upright ${mm(p.stopHeightMm)}; signed fold correction ${mm(facts.foldAllowanceMm)}`, "small")
    + rect(m, fY, d.fixtureBlankLengthMm, fixturePanelHeight, "cut")
    + line(m, fY + foot, m + d.fixtureBlankLengthMm, fY + foot, "score")
    + text(m + d.fixtureBlankLengthMm / 2, fY + foot / 2, "TAPE FOOT TO TABLE", "small", ' text-anchor="middle"')
    + text(m + d.fixtureBlankLengthMm / 2, fY + foot + (fixturePanelHeight - foot) / 2, "UPRIGHT", "small", ' text-anchor="middle"')
    + dimensionX(m, fY + fixturePanelHeight + 9, d.fixtureBlankLengthMm, mm(d.fixtureBlankLengthMm))
    + dimensionY(12, fY, fixturePanelHeight, mm(fixturePanelHeight))
    + footer(m, stationFooterY, revisionHash) + "</svg>";

  const instructions = {
    materials: [
      `Existing top-opening hinged-lid/tuck carton with measured usable interior ${mm(facts.cartonLengthMm)} × ${mm(facts.cartonWidthMm)} × ${mm(facts.cartonHeightMm)}. Exact flap/closure subtype must be physically tested.`,
      `Independently measured carton exterior footprint ${mm(facts.cartonOuterLengthMm)} × ${mm(facts.cartonOuterWidthMm)} controls exterior support placement; insert board thickness is not used to infer carton walls.`,
      `Confirmed cardboard ${mm(facts.boardThicknessMm)} thick; P01 blank ${mm(d.blankLengthMm)} × ${mm(d.blankWidthMm)}; two support blanks each ${mm(d.fixtureBlankLengthMm)} × ${mm(d.fixtureBlankWidthMm)}.`,
      "Ruler, cutting mat, marking/scoring tools, paper tape for tray tabs, and suitable removable tape to secure exterior support feet. A maker may prepare these supplies; record assistance.",
      `Actual stated closure: ${facts.closure}. Verify that required connectors and tools are available.`,
    ],
    assembly: [
      `Identify revision ${revisionHash}. Print SVG at 100% / actual size and measure both sides of its 50 mm check square before cutting. Never choose Fit to page.`,
      `If the drawing exceeds the printer, use a ruler to mark a ${mm(d.blankLengthMm)} × ${mm(d.blankWidthMm)} P01 rectangle on the confirmed sheet. Mark score lines ${mm(w)} from each outer edge: score-to-score ${mm(d.scoreLengthMm)} × ${mm(d.scoreWidthMm)}. Do not shrink the geometry.`,
      "Cut P01's outside contour and only the four solid corner slits. Score the amber dashed lines; do not cut them. Pre-fold walls and tabs, then tape overlapping corner tabs. Check item fit after the actual tab stack is formed.",
      `Fold coupon correction ${mm(facts.foldAllowanceMm)} is used by this template. Confirm the coupon/material match; a different board or corrected dimension requires a new checked revision.`,
      `Cut two S01/S02 strips ${mm(d.fixtureBlankLengthMm)} × ${mm(d.fixtureBlankWidthMm)}. Score across each strip ${mm(foot)} from its base edge and form a right-angle stop. Tape its foot to the table, outside the carton.`,
      `Mark the station envelope's front-left origin ${mm(p.offsetXMm)} right and ${mm(p.offsetYMm)} away from the work area's front-left corner. Place the carton ${mm(foot + d.registrationGapMm)} inside that origin on both axes. Use the station drawing to place ${p.strategy === "corner_stops" ? "one left and one rear stop" : "one front and one rear rail"}; maintain the declared registration gap.`,
      "Keep every permanent support outside the parcel. Exercise actual fresh-carton loading, full lid/flap travel, closure, extraction and reset before relying on the station. These scored/taped stops are proposed supports, not admitted or load-rated fixtures.",
      "Record material, scale, completed parts, maker assistance and deviations. Do not silently modify geometry or materials to make a trial pass.",
    ],
    operation: proposal.actions.map((a, i) => `${i + 1}. ${a.label} [${a.id}; ${a.hand === "active" ? facts.activeHand + " hand" : "passive support"}; target X ${mm(a.xMm)}, Y ${mm(a.yMm)}]`),
    tests: [
      "Confirm scale, coupon-based fit, actual folded dimensions and correct contents. This pack does not establish transport protection.",
      "Start with fresh packaging in the declared supply; verify independent loading without helper preload.",
      "Test each intended support transfer with the hand performing the actual next action. Check slip, stop bending, force and reach; geometry checks do not prove these.",
      "Exercise every actual lid/flap and the real closure. Confirm that no rail, tape, tab or stop obstructs the cycle.",
      "Release and remove the finished parcel; verify no permanent support becomes trapped. Reset the station and access the next package.",
      "Record uninterrupted evidence, assistance, undeclared hand/body use, all failed attempts and recording gaps. A human reviewer confirms outcomes for this exact build/revision.",
      ...proposal.assumptions.map((a) => `Unverified assumption: ${a}`),
    ],
  };
  if (cells.length) {
    instructions.materials.unshift(
      "Four measured component groups only: screws, washers, spacers and grommets. Counts and full-group envelopes below are confirmed inputs; capacity is never computed by multiplying a single-part dimension by count.",
      ...cells.map(cell => {
        const group = facts.kitComponents.find(component => component.id === cell.componentId)!;
        return `${cell.id} / ${cell.label}: exactly ${cell.requiredCount}; measured entire required group ${mm(group.bundleLengthMm)} × ${mm(group.bundleWidthMm)} × ${mm(group.bundleHeightMm)}. One hinged-top cell blank ${mm(cell.blankLengthMm)} × ${mm(cell.blankWidthMm)}; nominal inside ${mm(cell.insideLengthMm)} × ${mm(cell.insideWidthMm)}; wall height ${mm(cell.heightMm)}.`;
      }),
      "Actual inventory slip supplied at an appropriate size, or with an explicitly permitted fold. Confirm that it fits without defeating local closures; no unrelated notebook/item dimensions are used for kit capacity.",
    );
    instructions.assembly.splice(instructions.assembly.length - 1, 0,
      "P01 is the carrier for four separately constructed, independently closable P02 cells. Cyan rectangles in P01 and the station drawing show finished placement only; do not cut them into the carrier base.",
      ...cells.map(cell => `Make ${cell.id} for ${cell.label} × ${cell.requiredCount}: mark its complete ${mm(cell.blankLengthMm)} × ${mm(cell.blankWidthMm)} cut envelope. Inside that envelope the base starts ${mm(cell.heightMm)} from the left and ${mm(cell.lidDepthMm + cell.heightMm)} from the top. Score-to-score base is ${mm(cell.scoreLengthMm)} × ${mm(cell.scoreWidthMm)}. Transfer the labelled contour and four corner slits exactly; retain the integral rear hinged lid and front-wall tongue.`),
      "Fold each P02 tray's side/front/rear walls and tape its overlapping corner tabs using the declared connector. Preserve the rear-wall/lid hinge. Cut the receiving slot in the lid, not in a carrier-obstructed front wall. The front-wall tongue folds OVER the closed lid and its tapered end tucks into that lid slot, providing an independently accessible top closure.",
      ...cells.map(cell => `${cell.id} top lock: lid slot ${mm(cell.slotWidthMm)} × ${mm(cell.slotHeightMm)}, centred across the lid and ${mm(cell.slotFromTopMm)} from the lid's free/front edge. Front-wall tongue ${mm(cell.tabWidthMm)} wide × ${mm(cell.tabDepthMm)} long; fold it at the front wall's top edge. Test the real material/slot coupon and closure alignment before loading components. Do not silently widen a slot or shorten a tongue.`),
      ...cells.map(cell => `Place ${cell.id} finished OUTER lower-left at local X ${mm(cell.xMm)}, Y ${mm(cell.yMm)} from P01's finished INSIDE front-left corner. Secure its base with declared tape if required and record that construction. Its footprint is ${mm(cell.outerLengthMm)} × ${mm(cell.outerWidthMm)}. Local Y increases away from the operator; front-row lids must not obstruct rear-row lids or vice versa.`),
      "Prepare the carrier with EMPTY, OPEN, labelled P02 cells before the timed operating cycle. Prepared cardboard is declared supply, but screws/washers/spacers/grommets must never be preloaded. Comparable baselines receive equivalent preparation. Keep lid sweep, corner tabs and all local closure surfaces accessible.",
      "At operation, take/count the actual components into their assigned cell. Verify the required count, close THAT cell locally, and then continue in the validated action sequence. Closing the outer carton is a separate final action and cannot substitute for four independent cell closures.",
    );
    instructions.tests.unshift(
      "Verify every required group physically fits its assigned P02 cell, including the true full-group height under the locally closed lid. No component may straddle cells or be forced under a lid.",
      "Individually open, fill, close and release all four cell lids with the permitted hand/actions. Test real tuck force, lid-slot alignment, stability, retention and every flap sweep. Neighbor cells, P01 walls and the outer carton may still obstruct these motions; static dimensions do not prove access.",
      "Inspect exact counts, compartment assignment and four local closures before outer-carton closure. Test task handling for mixing or escape, including actual gaps around tabs/slots; the drawing alone does not establish small-part containment or shipping protection.",
      "Start with fresh packaging containing only empty/open prepared cells and component supplies not preloaded. Finish with inventory slip included, carton closed, parcel removed and station ready for the next order. Record every intervention, failed closure, wrong count and recording gap.",
    );
  }
  const list = (items: string[], ordered = false) => `<${ordered ? "ol" : "ul"}>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`;
  const printHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CounterShot construction pack — ${esc(proposal.title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#17212b;max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:28px}h2{margin-top:32px}.notice{padding:16px;border:2px solid #d97706;background:#fffbeb}.drawing{overflow:auto;border:1px solid #cbd5e1;margin:24px 0}.drawing svg{display:block;max-width:none;height:auto}li{margin:8px 0}code{word-break:break-all}button{padding:12px 20px;background:#17212b;color:white;border:0;cursor:pointer}@page{size:auto;margin:12mm}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}.no-print{display:none}.drawing{overflow:visible;border:0;break-before:page;break-after:page}.drawing svg{max-width:none!important;flex-shrink:0}h2{break-after:avoid}li{break-inside:avoid}}</style></head><body><p class="no-print notice"><strong>Print / Save as PDF:</strong> use your browser menu or Ctrl+P / Cmd+P. Select actual size / 100% and verify the scale square before cutting.</p><h1>${esc(proposal.title)}</h1><p>${esc(proposal.summary)}</p><p>Exact revision: <code>${esc(revisionHash)}</code></p><div class="notice"><strong>Proposed construction · physical trial required.</strong><p>Print at actual size / 100%, never Fit to page. Verify the 50 × 50 mm square. Tray drawing page: ${mm(sheetWidth)} × ${mm(sheetHeight)}; station drawing page: ${mm(stationSheetWidth)} × ${mm(stationSheetHeight)}. These may exceed A4/Letter. Use suitable large paper or the dimensioned ruler-marking instructions; this pack does not silently tile or shrink parts. Screen zoom is not a scale reference.</p></div><h2>Materials</h2>${list(instructions.materials)}<h2>Construction and ruler-marking route</h2>${list(instructions.assembly, true)}<h2>${cells.length ? "Full-scale P01 carrier and four independently closing P02 cells" : "Full-scale P01 tray"}</h2><div class="drawing">${packageSvg}</div><h2>Station reference and S01/S02 templates</h2><div class="drawing">${stationSvg}</div><h2>Operating sequence</h2>${list(instructions.operation, true)}<h2>Required physical checks</h2>${list(instructions.tests)}<p>Drawings, instructions and tests belong to the same revision. Model-inferred observations, confirmed facts, geometry checks and physical outcomes remain separate records.</p></body></html>`;
  return { packageSvg, stationSvg, printHtml, instructions, dimensions: d };
}
