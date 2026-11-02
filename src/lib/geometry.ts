import {
  constraintsSchema,
  proposalSchema,
  type CompiledDesign,
  type Constraints,
  type DesignRevision,
  type Drawing,
  type InputSnapshot,
  type Proposal,
} from "./contracts";
import { validatePlan } from "./domain";

export const escapeMarkup = (value: unknown): string =>
  String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
const n = (value: number) => Number(value.toFixed(2));
const line = (x1: number, y1: number, x2: number, y2: number, kind = "score") =>
  `<line class="${kind}" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"/>`;
const rect = (x: number, y: number, w: number, h: number, kind = "cut") =>
  `<rect class="${kind}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/>`;
const label = (x: number, y: number, text: string, size = 4) =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${size}">${escapeMarkup(text)}</text>`;
type Part = {
  id: string;
  title: string;
  w: number;
  h: number;
  quantity: number;
  geometry: string;
  purpose: string;
};
const emptyDimensions = {
  insertLengthMm: 0,
  insertWidthMm: 0,
  packageLengthMm: 0,
  packageWidthMm: 0,
  stationWidthMm: 0,
  stationDepthMm: 0,
};

function makeDrawing(part: Part, title: string): Drawing {
  const width = Math.max(part.w + 20, 175),
    height = part.h + 103;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${escapeMarkup(part.title)}">
<title>${escapeMarkup(part.id + ": " + part.title)}</title>
<style>text{font-family:Arial,sans-serif;fill:#182334}.cut{fill:none;stroke:#182334;stroke-width:.45}.score{fill:none;stroke:#205599;stroke-width:.35;stroke-dasharray:3 2}.reference{fill:none;stroke:#68798a;stroke-width:.3;stroke-dasharray:1 2}</style>
${label(10, 8, `${part.id} | ${part.title}`)}${label(10, 15, title.slice(0, 85), 3.3)}
<g transform="translate(10 23)">${part.geometry}</g>
${label(10, part.h + 33, `Part envelope ${n(part.w)} × ${n(part.h)} mm · quantity ${part.quantity}`, 3.5)}
${label(10, part.h + 40, "Nominal geometry; actual fit/fold and full operating cycle require trials.", 3.3)}
${line(10, part.h + 48, 28, part.h + 48, "cut")}${label(32, part.h + 49, "CUT", 3.3)}
${line(58, part.h + 48, 76, part.h + 48)}${label(80, part.h + 49, "SCORE / FOLD", 3.3)}
${line(10, part.h + 56, 28, part.h + 56, "reference")}${label(32, part.h + 57, "REFERENCE ONLY", 3.3)}
${rect(width - 62, height - 57, 50, 50, "reference")}${label(width - 60, height - 31, "50 mm", 4)}
${label(10, height - 21, "Print at actual size / 100%.", 3.5)}${label(10, height - 14, "Measure check square before cutting.", 3.5)}
</svg>`;
  return {
    id: part.id,
    title: part.title,
    widthMm: n(width),
    heightMm: n(height),
    svg,
    purpose: part.purpose,
  };
}

function crossPart(
  id: string,
  title: string,
  baseL: number,
  baseW: number,
  sideFlap: number,
  frontFlap: number,
  wall: number,
  quantity: number,
  purpose: string,
): Part {
  const x1 = sideFlap,
    x2 = sideFlap + baseL,
    x3 = 2 * sideFlap + baseL;
  const y1 = frontFlap,
    y2 = frontFlap + baseW,
    y3 = 2 * frontFlap + baseW;
  const points = [
    [x1, 0],
    [x2, 0],
    [x2, y1],
    [x3, y1],
    [x3, y2],
    [x2, y2],
    [x2, y3],
    [x1, y3],
    [x1, y2],
    [0, y2],
    [0, y1],
    [x1, y1],
  ]
    .map((p) => p.map(n).join(","))
    .join(" ");
  let geometry =
    `<polygon class="cut" points="${points}"/>` +
    line(x1, y1, x2, y1) +
    line(x1, y2, x2, y2) +
    line(x1, y1, x1, y2) +
    line(x2, y1, x2, y2);
  if (wall > 0 && frontFlap > wall && sideFlap > wall)
    geometry +=
      line(x1, y1 - wall, x2, y1 - wall) +
      line(x1, y2 + wall, x2, y2 + wall) +
      line(x1 - wall, y1, x1 - wall, y2) +
      line(x2 + wall, y1, x2 + wall, y2);
  geometry += label(
    x1 + 5,
    y1 + baseW / 2,
    `${n(baseL)} × ${n(baseW)} mm base`,
    4,
  );
  geometry += label(
    x1 + 5,
    y1 + baseW / 2 + 7,
    `Side flap ${n(sideFlap)}; front/rear flap ${n(frontFlap)} mm`,
    3.2,
  );
  if (wall > 0)
    geometry += label(
      x1 + 5,
      y1 + baseW / 2 + 14,
      `Height score offset ${n(wall)} mm (nominal)`,
      3.2,
    );
  return { id, title, w: x3, h: y3, geometry, quantity, purpose };
}

/** Deterministic nominal planar geometry, not a structural or shipping certification. */
export function compileDesign(
  proposal: Proposal,
  constraints: Constraints,
): CompiledDesign {
  const report = validatePlan(proposal, constraints);
  if (
    !constraintsSchema.safeParse(constraints).success ||
    !proposalSchema.safeParse(proposal).success
  )
    return {
      drawings: [],
      cutList: [],
      sharedDimensions: { ...emptyDimensions },
      report,
      assembly: [],
    };
  const c = constraints,
    p = proposal,
    t = c.cardboardThicknessMm,
    gap = p.clearanceMm;
  const trial = (rule: string, message: string) =>
    report.issues.push({ rule, severity: "trial_required", message });
  const fail = (rule: string, message: string) =>
    report.issues.push({ rule, severity: "error", message });
  const portrait = p.orientation === "portrait";
  const itemL = portrait ? c.itemWidthMm : c.itemLengthMm,
    itemW = portrait ? c.itemLengthMm : c.itemWidthMm;
  const insertL =
    p.insert === "none"
      ? 0
      : itemL + 2 * gap + (p.insert === "tray" ? 2 * t : 0);
  const insertW =
    p.insert === "none"
      ? 0
      : itemW + 2 * gap + (p.insert === "tray" ? 2 * t : 0);
  const contentsL = insertL || itemL,
    contentsW = insertW || itemW;
  let packL = contentsL + 2 * gap,
    packW = contentsW + 2 * gap;
  let packH =
    Math.max(
      c.itemHeightMm + (p.insert === "none" ? 0 : t),
      p.insert === "tray" ? p.insertWallHeightMm + t : 0,
    ) + gap;
  if (p.packageFamily === "tuck_carton") {
    packL = (portrait ? c.cartonWidthMm : c.cartonLengthMm) ?? 0;
    packW = (portrait ? c.cartonLengthMm : c.cartonWidthMm) ?? 0;
    packH = c.cartonHeightMm ?? 0;
    if (
      contentsL + 2 * gap > packL ||
      contentsW + 2 * gap > packW ||
      Math.max(
        c.itemHeightMm + (p.insert === "none" ? 0 : t),
        p.insert === "tray" ? p.insertWallHeightMm + t : 0,
      ) +
        gap >
        packH
    )
      fail(
        "PACKAGE_FIT",
        "The item/insert plus declared clearances does not fit the confirmed usable carton interior.",
      );
  }
  if (packL <= 0 || packW <= 0 || packH <= 0)
    return {
      drawings: [],
      cutList: [],
      sharedDimensions: { ...emptyDimensions },
      report: { valid: false, issues: report.issues },
      assembly: [],
    };
  const externalL = packL + 2 * t,
    externalW = packW + 2 * t;
  if (p.packageFamily === "tuck_carton")
    trial(
      "CARTON_EXTERIOR",
      "Only the existing carton's usable interior was measured. The exterior reference provisionally adds twice the construction-board thickness; verify its actual outside footprint and revise exterior supports if different.",
    );
  const margin = 30;
  const stationW =
    externalL + 2 * margin + (p.arrangement === "flap_parking" ? 60 : 0);
  const stationD = externalW + 2 * margin;
  if (
    p.stationXMm + stationW > c.workspaceWidthMm ||
    p.stationYMm + stationD > c.workspaceDepthMm
  )
    fail(
      "STATION_BOUNDS",
      `The ${n(stationW)} × ${n(stationD)} mm station at the proposed position exceeds the declared workspace.`,
    );
  const parts: Part[] = [];
  if (p.insert === "flat")
    parts.push({
      id: "I01",
      title: "Flat transfer insert",
      w: insertL,
      h: insertW,
      quantity: 1,
      geometry:
        rect(0, 0, insertL, insertW) +
        label(5, 12, "Transfer surface; no retaining walls"),
      purpose:
        "Travels inside the parcel; contents retention must be demonstrated.",
    });
  if (p.insert === "tray")
    parts.push(
      crossPart(
        "I01",
        "Open retaining insert",
        insertL - 2 * t,
        insertW - 2 * t,
        p.insertWallHeightMm,
        p.insertWallHeightMm,
        0,
        1,
        "Fold four walls; maker joins exterior corners using the declared connector. Insert travels with parcel.",
      ),
    );
  if (p.packageFamily === "wraparound")
    parts.push(
      crossPart(
        "P01",
        "Wraparound package blank",
        packL,
        packW,
        packH + 15,
        packH + packW * 0.65,
        packH,
        1,
        "Nominal cross-wrap with overlapping panels. Use and test the declared closure; no transport-protection claim.",
      ),
    );
  else
    parts.push({
      id: "P00",
      title: "Existing carton reference — do not cut",
      w: externalL,
      h: externalW,
      quantity: 0,
      geometry:
        rect(0, 0, externalL, externalW, "reference") +
        label(
          5,
          12,
          `Usable inside ${n(packL)} × ${n(packW)} × ${n(packH)} mm`,
          3.5,
        ),
      purpose:
        "Reference footprint for an existing measured carton. This drawing does not manufacture the carton.",
    });
  let stationGeometry =
    rect(0, 0, stationW, stationD) +
    rect(margin, margin, externalL, externalW, "reference") +
    label(margin + 4, margin + 12, "FINISHED PACKAGE REFERENCE", 3.3);
  if (p.arrangement === "corner_nest")
    stationGeometry +=
      line(
        margin - 5,
        margin,
        margin - 5,
        margin + externalW * 0.7,
        "reference",
      ) +
      line(
        margin,
        margin + externalW + 5,
        margin + externalL * 0.7,
        margin + externalW + 5,
        "reference",
      );
  if (p.arrangement === "side_guides")
    stationGeometry +=
      line(margin - 5, margin, margin - 5, margin + externalW, "reference") +
      line(
        margin + externalL + 5,
        margin,
        margin + externalL + 5,
        margin + externalW,
        "reference",
      );
  if (p.arrangement === "flap_parking")
    stationGeometry +=
      line(
        margin,
        margin + externalW + 5,
        margin + externalL * 0.7,
        margin + externalW + 5,
        "reference",
      ) +
      rect(stationW - 55, margin + 10, 40, 50, "reference") +
      label(stationW - 55, margin + 8, "PARK / TEST", 3);
  parts.push({
    id: "S01",
    title: "Workspace station base and registration layout",
    w: stationW,
    h: stationD,
    quantity: 1,
    geometry: stationGeometry,
    purpose:
      "Reference marks locate exterior supports. Keep the front release direction open; physically admit fresh blank and full fold path before fixing supports.",
  });
  const lengths =
    p.arrangement === "side_guides"
      ? [externalW, externalW]
      : p.arrangement === "corner_nest"
        ? [externalW * 0.7, externalL * 0.7]
        : [externalL * 0.7];
  lengths.forEach((length, index) =>
    parts.push({
      id: `S${String(index + 2).padStart(2, "0")}`,
      title:
        p.arrangement === "side_guides"
          ? "Exterior side guide"
          : "Exterior registration stop",
      w: length,
      h: p.stopHeightMm + 20,
      quantity: 1,
      geometry:
        rect(0, 0, length, p.stopHeightMm + 20) +
        line(0, 20, length, 20) +
        label(4, 12, "20 mm attachment foot", 3.3),
      purpose:
        "Fold foot and attach outside the moving package using declared maker connector. No internal restraint.",
    }),
  );
  if (p.arrangement === "flap_parking")
    parts.push({
      id: "S04",
      title: "Exterior flap-parking ledge",
      w: 45,
      h: 70,
      quantity: 1,
      geometry:
        rect(0, 0, 45, 70) +
        line(0, 20, 45, 20) +
        line(0, 55, 45, 55) +
        label(3, 12, "Foot", 3.3) +
        label(3, 40, "Upright", 3.3) +
        label(3, 65, "Ledge", 3.3),
      purpose:
        "Candidate passive flap parking only. Confirm that the actual flap stays retained and releases without another hand.",
    });
  for (const part of parts.filter((p) => p.quantity > 0)) {
    if (!(
      (part.w <= c.sheetWidthMm && part.h <= c.sheetHeightMm) ||
      (part.h <= c.sheetWidthMm && part.w <= c.sheetHeightMm)
    ))
      fail(
        "STOCK_SHEET_FIT",
        `${part.id} needs ${n(part.w)} × ${n(part.h)} mm of stock and cannot fit the declared ${c.sheetWidthMm} × ${c.sheetHeightMm} mm sheet in either permitted orientation.`,
      );
  }
  report.issues.push({
    rule: "STOCK_QUANTITY",
    severity: "warning",
    message:
      "Stock checks fit each individual part to the declared sheet size. The cut list may require multiple sheets; available sheet count and combined nesting are not established by these checks.",
  });
  trial(
    "MATERIAL_CALIBRATION",
    "Panel dimensions are nominal. Measure a fold/fit coupon on this exact cardboard; thickness alone does not establish score allowance, rigidity or joint clearance. A material or geometry correction requires a new design revision.",
  );
  trial(
    "RELEASE_CLEARANCE",
    "Demonstrate fresh-package loading, every intermediate hold, closure, front/top extraction and independent reset. The final footprint does not prove the complete motion path.",
  );
  if (p.packageFamily === "wraparound")
    trial(
      "FLAT_BLANK_CLEARANCE",
      "Fixed supports shown around the finished footprint may intersect initially flat flaps. Admit the entire flat blank and fold sweep before permanently fixing the stops; revise the support/blank/sequence if blocked.",
    );
  if (p.stopHeightMm > packH)
    trial(
      "CLOSURE_ACCESS",
      "The proposed support is taller than the nominal package; test closure and finger access before admitting this arrangement.",
    );
  const sharedDimensions = {
    insertLengthMm: n(insertL),
    insertWidthMm: n(insertW),
    packageLengthMm: n(packL),
    packageWidthMm: n(packW),
    stationWidthMm: n(stationW),
    stationDepthMm: n(stationD),
  };
  report.valid = !report.issues.some((i) => i.severity === "error");
  const assembly = [
    "Verify the design revision, confirmed dimensions, actual material thickness and 50 mm print-scale square. Drawing precision is not manufacturing accuracy.",
    "Prepare one trial set first. Cut solid outlines; score the dashed fold lines without cutting through. Reference lines and the check square are not cut features.",
    p.insert === "tray"
      ? "Fold I01 walls and join exterior corners with the declared maker connector. Verify the resulting outside dimensions and retaining behavior."
      : p.insert === "flat"
        ? "Cut I01 and test transfer of all loose contents; a flat surface does not automatically retain them."
        : "This design has no insert. Do not use an insert as an unrecorded support.",
    p.packageFamily === "wraparound"
      ? "P01 is a nominal wrap. Test both height scores, overlap and the declared closure around the actual contents. Admit fresh flat-blank placement before fixing station supports."
      : "Use the actual measured existing carton. P00 is a reference drawing and must not be cut as a substitute carton.",
    `Place S01 at workspace X=${p.stationXMm} mm, Y=${p.stationYMm} mm; ${p.orientation} orientation. Registration marks describe the finished footprint, not proof of flap clearance.`,
    "Fold exterior support feet and temporarily position them at reference marks. Keep every reusable fixture exterior and a clear front/top release path. Permanently attach only after loading/fold/release trials pass.",
    "Initial maker cutting and construction may use assistance. Record it separately. Every operating cycle must start with fresh unused packaging and finish with the parcel released and the station reset.",
    "Inspect contents and the defined closure after each actual trial. These parts have no verified load rating, shipping protection or general accessibility certification.",
  ];
  return {
    drawings: report.valid
      ? parts.map((part) => makeDrawing(part, p.title))
      : [],
    cutList: parts
      .filter((p) => p.quantity > 0)
      .map((part) => ({
        part: `${part.id} ${part.title}`,
        quantity: part.quantity,
        widthMm: n(part.w),
        heightMm: n(part.h),
        material: `Declared cardboard, ${t} mm; verify material/fold coupon`,
      })),
    sharedDimensions,
    report,
    assembly,
  };
}

/** A4 tiles preserve 1 SVG user-unit = 1 mm, with 10 mm overlapping edges. */
export function renderPrintPack(
  design: DesignRevision,
  snapshot: InputSnapshot,
): string {
  if (
    design.inputSnapshotId !== snapshot.id ||
    design.inputHash !== snapshot.hash
  )
    throw new Error("The design and input snapshot do not match.");
  if (!design.compiled.report.valid || !design.compiled.drawings.length)
    throw new Error(
      "A design with failed checks has no construction print pack.",
    );
  const esc = escapeMarkup;
  const sections: string[] = [];
  for (const drawing of design.compiled.drawings) {
    const tags = drawing.svg.match(/<[^>]+>/g) ?? [];
    if (
      tags.some(
        (tag) =>
          /<\/?(?:script|foreignObject|iframe|image|use|a)\b/i.test(tag) ||
          /\bon[a-z]+\s*=|\b(?:href|src)\s*=/i.test(tag),
      )
    )
      throw new Error("Unsafe drawing markup.");
    const inner = drawing.svg
      .replace(/^<svg\b[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
    const cols = Math.max(1, Math.ceil((drawing.widthMm - 10) / 180));
    const rows = Math.max(1, Math.ceil((drawing.heightMm - 10) / 255));
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++) {
        const x = col * 180,
          y = row * 255;
        let registration = "";
        for (let gx = 0; gx <= cols; gx++)
          for (let gy = 0; gy <= rows; gy++) {
            const xx = gx * 180 + 5,
              yy = gy * 255 + 5;
            if (xx >= x && xx <= x + 190 && yy >= y && yy <= y + 265)
              registration +=
                line(xx - 2, yy, xx + 2, yy, "reference") +
                line(xx, yy - 2, xx, yy + 2, "reference");
          }
        sections.push(
          `<section class="tile"><header>${esc(drawing.id)} · ${esc(design.id)} · tile ${row + 1}/${rows}, ${col + 1}/${cols} · 100% / actual size</header><svg xmlns="http://www.w3.org/2000/svg" width="190mm" height="265mm" viewBox="${x} ${y} 190 265">${inner}<g>${registration}</g></svg></section>`,
        );
      }
  }
  const warnings = design.compiled.report.issues
    .filter((i) => i.severity !== "error")
    .map((i) => `<li>${esc(i.message)}</li>`)
    .join("");
  const cutList = design.compiled.cutList
    .map(
      (p) =>
        `<li>${esc(p.part)}: ${p.quantity} × ${p.widthMm} × ${p.heightMm} mm. ${esc(p.material)}</li>`,
    )
    .join("");
  const purposes = design.compiled.drawings
    .map((d) => `<li><strong>${esc(d.id)}</strong>: ${esc(d.purpose)}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(design.proposal.title)} — CounterShot construction pack</title><style>
@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}body{font:12pt Arial,sans-serif;color:#182334;margin:0;background:white}main{max-width:190mm;margin:auto}h1{font-size:22pt}h2{font-size:15pt}li{margin-bottom:3mm}.intro{padding:8mm 0;break-after:page}.tile{width:190mm;height:277mm;overflow:hidden;break-after:page;page-break-after:always}.tile:last-child{break-after:auto;page-break-after:auto}.tile header{height:12mm;font-size:8pt;padding-top:2mm;overflow:hidden}.tile svg{display:block;width:190mm;height:265mm}button{padding:3mm 5mm} @media screen{body{background:#edf0f4}.intro,.tile{background:white;margin:8mm auto;box-shadow:0 1mm 3mm #0002}.intro{padding:8mm}.tile{outline:1px solid #ccd2dc}}@media print{button{display:none}.tile,.intro{margin:0;box-shadow:none}}</style></head><body><main><section class="intro"><h1>CounterShot construction pack</h1><p>${esc(design.proposal.title)}</p><p>Revision ${design.number} · ${esc(design.id)}<br>Input ${esc(snapshot.hash)}</p><p>Print A4 portrait at <strong>100% / actual size</strong>, with browser headers/footers disabled. Never use Fit to page. Measure the 50 mm square before cutting. Each drawing uses 10 mm overlap: align matching lines and registration marks, then tape tiles together. Alternatively use the dimensioned SVG and a ruler. Reference marks are not cut lines.</p><p><strong>Use your browser Print command (Ctrl+P or Cmd+P)</strong> to print or save as PDF.</p><h2>Cut list</h2><ul>${cutList}</ul><h2>Part purposes</h2><ul>${purposes}</ul><h2>Assembly and operating boundary</h2><ol>${design.compiled.assembly.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><h2>Physical tests still required</h2><ul>${warnings}</ul><h2>Operating sequence</h2><ol>${design.proposal.steps.map((s) => `<li><strong>${esc(s.label)}</strong>: ${esc(s.instruction)}</li>`).join("")}</ol></section>${sections.join("")}</main></body></html>`;
}
