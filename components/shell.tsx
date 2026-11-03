"use client";

import Link from "next/link";
import { Camera, FolderOpen, Layers3, ScanLine } from "lucide-react";
import type { ReactNode } from "react";

export function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true"><svg viewBox="0 0 36 36" fill="none"><path d="M6 11L18 4L30 11V25L18 32L6 25V11Z" stroke="currentColor" strokeWidth="2.6"/><path d="M6 11L18 18L30 11M18 18V32M12 7.5L24 14.5" stroke="currentColor" strokeWidth="2.6"/><path d="M24 3V11M20 7H28" stroke="currentColor" strokeWidth="2.6"/></svg></span>;
}

export function Shell({ children, projectId, current = "Projects" }: { children: ReactNode; projectId?: string; current?: string }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="CounterShot home"><Mark/><span>CounterShot<span className="brand-dot">.</span></span></Link>
      <nav className={`side-nav${projectId ? "" : " primary-nav"}`} aria-label="Main navigation">
        <Link href="/camera" className={current === "Camera" ? "active" : ""}><Camera size={18}/> Camera</Link>
        <Link href="/" className={current === "Projects" ? "active" : ""}><FolderOpen size={18}/> Projects <span className="nav-dot"/></Link>
        {projectId && <><Link href={`/projects/${projectId}/design`} className={current === "Workbench" ? "active" : ""}><Layers3 size={18}/> Workbench</Link>
        <Link href={`/projects/${projectId}/trials`} className={current === "Evidence" ? "active" : ""}><ScanLine size={18}/> Evidence</Link></>}
      </nav>
    </aside>
    <main className="main-area">{children}</main>
  </div>;
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`status-pill ${tone}`}><span/>{children}</span>; }

export function CameraIllustration() {
  return <svg className="station-illustration" viewBox="0 0 600 420" role="img" aria-label="Illustration of a camera snapshot with labelled parts, one proposed move and a separate after-view check.">
    <rect x="32" y="30" width="390" height="320" rx="20" fill="#edf0e5" stroke="#c5cebb"/>
    <rect x="48" y="46" width="358" height="268" rx="10" fill="#faf8ef"/>
    <g stroke="#d7dccf" strokeWidth="1"><path d="M48 110H406M48 178H406M48 246H406M120 46V314M192 46V314M264 46V314M336 46V314"/></g>
    <g fill="none" strokeLinecap="round" strokeWidth="7"><path d="M93 254L147 254Q165 254 165 232V157Q165 130 193 130H296" stroke="#d86843"/><path d="M93 273H201Q224 273 224 248V191Q224 172 247 172H326" stroke="#77936b"/><path d="M93 291H280Q299 291 299 269V213H346" stroke="#a7b291"/></g>
    <g fill="#e9e3d1" stroke="#a99f87" strokeWidth="1.5"><rect x="73" y="245" width="30" height="56" rx="4"/><rect x="293" y="114" width="39" height="31" rx="4"/><rect x="323" y="157" width="39" height="31" rx="4"/><rect x="343" y="199" width="39" height="31" rx="4"/></g>
    <rect x="143" y="107" width="65" height="72" rx="7" fill="none" stroke="#d86843" strokeDasharray="5 4" strokeWidth="2"/>
    <g fill="#556848" fontFamily="Arial,sans-serif" fontSize="12"><text x="74" y="232">A</text><text x="302" y="105">J1</text><text x="329" y="149">J2</text><text x="348" y="190">J3</text></g>
    <rect x="252" y="72" width="131" height="25" rx="12" fill="#fffdf7" stroke="#d5d9cb"/><text x="265" y="88" fontFamily="monospace" fontSize="10" fill="#6a735d">ILLUSTRATIVE VIEW</text>
    <rect x="318" y="244" width="247" height="127" rx="12" fill="#fffdf7" stroke="#d1d8c6"/>
    <circle cx="342" cy="269" r="8" fill="#d86843"/><text x="359" y="273" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="700" fill="#394b32">One concrete next move</text>
    <g fontFamily="Arial,sans-serif" fontSize="12" fill="#67745e"><text x="337" y="299">Move the labelled branch.</text><text x="337" y="319">Show the result in a new frame.</text><text x="337" y="342" fill="#9b5a3e">Retake if the connection is hidden.</text></g>
    <path d="M222 153L265 198L330 244" fill="none" stroke="#b8c2aa" strokeDasharray="4 5" strokeWidth="1.5"/>
    <text x="57" y="337" fill="#7a846d" fontFamily="monospace" fontSize="10">FRAME → ACTION → OPERATOR CHECK</text>
  </svg>;
}

export function StationIllustration() {
  return <svg className="station-illustration" viewBox="0 0 600 420" role="img" aria-label="Untested concept of a temporary workshop assembly jig holding three pre-cut enclosure walls on a base panel. Split cardboard braces remain outside the workpiece, a removable front gate is parked to the side, and a dotted arrow shows forward extraction.">
    <defs>
      <pattern id="workshop-dot-grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d6d1c5"/></pattern>
      <filter id="workshop-soft-shadow"><feGaussianBlur stdDeviation="10"/></filter>
      <marker id="workshop-extraction-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="none" stroke="#6d8065" strokeWidth="1.4"/></marker>
    </defs>
    <rect width="600" height="420" fill="url(#workshop-dot-grid)"/>
    <ellipse cx="303" cy="310" rx="184" ry="30" fill="#8a7860" opacity=".12" filter="url(#workshop-soft-shadow)"/>
    <g strokeLinejoin="round" strokeWidth="1.4">
      <path d="M92 267L303 155L518 270L307 383Z" fill="#eae4d5" stroke="#b7ad99"/>
      <path d="M92 267V277L307 394V383Z" fill="#d9cdb7" stroke="#b7ad99"/>
      <path d="M307 383L518 270V280L307 394Z" fill="#c5b79c" stroke="#b7ad99"/>
      <path d="M157 258L300 182L443 258L300 334Z" fill="#e7e7d4" stroke="#a8ae97"/>
      <path d="M157 258V265L300 342V334Z" fill="#c2c9ae" stroke="#9aa387"/>
      <path d="M300 334L443 258V265L300 342Z" fill="#aeb899" stroke="#9aa387"/>
      <path d="M157 258V171L300 95V182Z" fill="#f2ead6" stroke="#b5aa8f"/>
      <path d="M157 171L164 167L307 91L300 95Z" fill="#fff9e9" stroke="#b5aa8f"/>
      <path d="M300 95L443 171V258L300 182Z" fill="#d9c9a7" stroke="#b5aa8f"/>
      <path d="M300 95L307 91L450 167L443 171Z" fill="#f3e7cc" stroke="#b5aa8f"/>
      <path d="M443 171L450 167V254L443 258Z" fill="#c0ae88" stroke="#b5aa8f"/>
      <path d="M443 258V171L300 247V334Z" fill="#f4ecd8" stroke="#b5aa8f"/>
      <path d="M443 171L450 167L307 243L300 247Z" fill="#fff8e7" stroke="#b5aa8f"/>
      <path d="M300 247L307 243V330L300 334Z" fill="#c5b895" stroke="#b5aa8f"/>
      <path d="M300 95V182M157 258L300 182L443 258" fill="none" stroke="#9d967d" strokeDasharray="3 4" strokeWidth="1"/>
      <path d="M177 241V250L190 243V234M210 223V232L223 225V216M244 205V214L257 207V198M277 187V196L290 189V180" fill="none" stroke="#a59c83" strokeWidth="1.2"/>
      <path d="M320 194V203L332 210V201M354 212V221L367 228V219M389 231V240L402 247V238M423 249V258L435 265V256" fill="none" stroke="#b3a489" strokeWidth="1.2"/>
      <path d="M328 276L344 267V284L328 293ZM355 261L371 252V269L355 278ZM382 246L398 237V254L382 263Z" fill="#d7cfb9" stroke="#c7bba1" strokeWidth=".9"/>
      <path d="M181 189L226 165V173L181 197ZM181 203L211 187V195L181 211Z" fill="#dfd8c1" stroke="none"/>

      <path d="M130 250L158 258L158 187Z" fill="#e58d62" stroke="#b7603c"/>
      <path d="M130 250L139 255L167 263L158 258Z" fill="#bf5d38" stroke="#b7603c"/>
      <path d="M141 246L152 249V219Z" fill="#f7e8d1" stroke="#b7603c" strokeWidth=".8"/>
      <path d="M130 250L118 256L147 272L176 256L167 251L147 261Z" fill="#dc7048" stroke="#b7603c"/>
      <path d="M354 209L378 198L354 160Z" fill="#e58d62" stroke="#b7603c"/>
      <path d="M354 209L363 214L387 203L378 198Z" fill="#b85a36" stroke="#b7603c"/>
      <path d="M361 198L370 194L361 180Z" fill="#f7e8d1" stroke="#b7603c" strokeWidth=".8"/>
      <path d="M400 281L430 297L400 230Z" fill="#df8055" stroke="#b7603c"/>
      <path d="M400 281L389 287L419 303L430 297Z" fill="#b95a36" stroke="#b7603c"/>
      <path d="M408 272L419 288L408 282Z" fill="#f5e4ca" stroke="#b7603c" strokeWidth=".8"/>

      <path d="M111 290L159 316L147 323L99 297Z" fill="#e38459" stroke="#b7603c"/>
      <path d="M99 297V314L147 340V323Z" fill="#c2653e" stroke="#b7603c"/>
      <path d="M147 323L159 316V333L147 340Z" fill="#a95130" stroke="#b7603c"/>
      <path d="M116 306L125 311V321L116 316Z" fill="#edd2b3" stroke="#a95130" strokeWidth=".8"/>
      <path d="M169 270L179 275M279 329L289 334" fill="none" stroke="#c46a43" strokeWidth="3"/>
    </g>
    <path d="M259 304L199 336L169 353" fill="none" stroke="#6d8065" strokeWidth="1.5" strokeDasharray="5 5" markerEnd="url(#workshop-extraction-arrow)"/>
    <path d="M174 280L151 293" fill="none" stroke="#bb7751" strokeWidth="1.1" strokeDasharray="3 4"/>
    <g fill="none" stroke="#999a8b" strokeWidth="1" strokeDasharray="3 4"><path d="M148 230L96 190H27"/><path d="M422 277L507 218H575"/><path d="M131 318L100 357H27"/></g>
    <g fill="#626653" fontFamily="monospace" fontSize="8" letterSpacing=".65"><text x="25" y="178">TEMPORARY WALL BRACES</text><text x="433" y="206">JOIN · RELEASE · EXTRACT</text><text x="25" y="375">REMOVABLE FRONT GATE</text></g>
    <g fill="#d56542"><circle cx="148" cy="230" r="2.6"/><circle cx="422" cy="277" r="2.6"/><circle cx="131" cy="318" r="2.6"/></g>
    <rect x="25" y="28" width="151" height="24" rx="12" fill="#fffdf7" stroke="#ddd8cd"/>
    <text x="38" y="44" fill="#73746b" fontFamily="monospace" fontSize="9" letterSpacing=".7">CONCEPT · NOT TESTED</text>
  </svg>;
}
