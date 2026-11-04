// Draws the site's logo, the family of S:\wren\tools\make_logo.ps1 and the toolkit's `tk make_logo`: a rounded square
// with a soft vertical gradient and a darker border just inside its edge (a gradient too, so it stays darker than the
// body everywhere), a faint highlight along the top inner edge, an optional semicircular notch in the middle of the
// top edge, and a figure on it. The figure is pluggable: "empty" (the frame alone) or an SVG file of white shapes in
// the square's 512-unit coordinates (see assets/figure-example.svg for what it may hold).
//
// Writes logo.svg (the web asset, full detail), logo.png (512), logo_256/64/32/16.png and favicon.ico
// (16/24/32/48/64/128/256). Small sizes use a simpler drawing, as the family does: 2 = full (64 px and up), 1 = 32-48 px
// (the figure a little larger, its shapes marked data-min-detail="2" left out), 0 = 16-24 px (no notch, no highlight,
// a thin margin, a thicker border, the figure larger still, only its shapes without data-min-detail).
// Plain Node >= 20, no packages: it rasterizes the shapes itself and writes PNG with node:zlib and a CRC32.
//   node logo.mjs [out-dir]          the files, from site.json's "logo" (default out-dir: logo-out/)
//   node logo.mjs --sheet [out-dir]  the files and sizes.html: every PNG on a light and on a dark background
// build.mjs calls makeLogo() and writes them into dist/.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const UNITS = 512;            // the drawing's coordinates: a 512 x 512 canvas
const SUPERSAMPLE = 4;        // samples per pixel along each axis
const ARC_STEPS = 24;         // segments per quarter circle when an arc becomes a polygon
const CURVE_STEPS = 24;       // segments per Bezier curve of a figure
const PNG_SIZES = [512, 256, 64, 32, 16];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICO_LARGEST = 256;      // an .ico directory writes 256 as 0
const HIGHLIGHT_ALPHA = 40;   // of 255: the white line along the top inner edge
const HIGHLIGHT_WIDTH = 2;
const NOTCH_RADIUS = 34;      // per 400 units of square
const SQUARE_REFERENCE = 400; // the full-detail square, the notch is scaled from it
const FIGURE_CENTRE = 256;    // the figure is scaled about the middle of the canvas
const SHEET_LIGHT = "#eef0f4"; // the check sheet's backgrounds (a light and a dark taskbar)
const SHEET_DARK = "#2b2f38";

// The colour variants: body top, body bottom, border top, border bottom.
export const PALETTES = {
  amber: ["#f39a2e", "#c25a0c", "#d9781c", "#8c3a05"],     // Wren
  violet: ["#7b63f2", "#4a2fc0", "#5f47d8", "#2c1984"],
  cobalt: ["#2f6fd8", "#0b3f9c", "#1a4fae", "#062a6e"],    // the toolkit
  blueprint: ["#2363b8", "#153f86", "#1a4f9c", "#0b2560"], // Wren's development builds, without their grid
};

// The square at each detail level: margin, corner radius, border width; the figure's scale.
const GEOMETRY = [
  { margin: 20, radius: 110, border: 18, figureScale: 1.22 },
  { margin: 56, radius: 100, border: 10, figureScale: 1.1 },
  { margin: 56, radius: 100, border: 10, figureScale: 1.0 },
];
const FULL_DETAIL = 2;
const detailFor = (size) => (size <= 24 ? 0 : size <= 48 ? 1 : FULL_DETAIL);

// ---- shapes: rings of [x, y] points in units ----

// The square inset by `d`: its radius shrinks and its notch grows by d (the inside of a stroke along the edge).
function frameAt(detail, notch, d) {
  const g = GEOMETRY[detail];
  const side = UNITS - 2 * g.margin;
  const notchRadius = notch && detail > 0 ? (NOTCH_RADIUS * side) / SQUARE_REFERENCE : 0;
  return { x: g.margin + d, y: g.margin + d, w: side - 2 * d, r: g.radius - d, nr: notchRadius ? notchRadius + d : 0 };
}

function arc(points, cx, cy, r, from, to) {
  const steps = Math.max(1, Math.ceil((Math.abs(to - from) / (Math.PI / 2)) * ARC_STEPS));
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

// A rounded square, clockwise on screen (y down), the notch a half circle cut down into the top edge.
function frameRing({ x, y, w, r, nr }) {
  const p = [];
  const half = Math.PI / 2;
  arc(p, x + r, y + r, r, Math.PI, 3 * half);
  if (nr > 0) arc(p, x + w / 2, y, nr, Math.PI, 0);
  arc(p, x + w - r, y + r, r, 3 * half, 2 * Math.PI);
  arc(p, x + w - r, y + w - r, r, 0, half);
  arc(p, x + r, y + w - r, r, half, Math.PI);
  return p;
}

function frameSvgPath({ x, y, w, r, nr }) {
  const notch = nr > 0 ? `H${x + w / 2 - nr}A${nr} ${nr} 0 0 0 ${x + w / 2 + nr} ${y}` : "";
  return `M${x + r} ${y}${notch}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + w}`
    + `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + w - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

// ---- the figure: an SVG file's shapes ----

const SHAPE = /<(rect|circle|ellipse|polygon|path)\b([^>]*?)\/>/g;
const attribute = (attrs, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
const number = (attrs, name, fallback = 0) => Number(attribute(attrs, name) ?? fallback);

function parseColour(text) {
  if (!text || text === "white") return [255, 255, 255, 255];
  if (text === "black") return [0, 0, 0, 255];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!hex) throw new Error(`fill "${text}": use white, black, #rgb or #rrggbb`);
  const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(255);
}

// A path's d: M L H V C Q Z (absolute or relative), curves flattened.
function pathRings(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const rings = [];
  let ring = null, x = 0, y = 0, command = "", i = 0;
  const next = () => Number(tokens[i++]);
  const curve = (points) => {
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      let level = points;
      while (level.length > 1) level = level.slice(1).map((p, k) => [level[k][0] + (p[0] - level[k][0]) * t, level[k][1] + (p[1] - level[k][1]) * t]);
      ring.push(level[0]);
    }
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (command.toUpperCase()) {
      case "M": x = ox + next(); y = oy + next(); ring = [[x, y]]; rings.push(ring); command = rel ? "l" : "L"; break;
      case "L": x = ox + next(); y = oy + next(); ring.push([x, y]); break;
      case "H": x = ox + next(); ring.push([x, y]); break;
      case "V": y = oy + next(); ring.push([x, y]); break;
      case "C": { const a = [ox + next(), oy + next()], b = [ox + next(), oy + next()], c = [ox + next(), oy + next()]; curve([[x, y], a, b, c]); [x, y] = c; break; }
      case "Q": { const a = [ox + next(), oy + next()], c = [ox + next(), oy + next()]; curve([[x, y], a, c]); [x, y] = c; break; }
      case "Z": [x, y] = ring[0]; ring = [[x, y]]; rings.push(ring); break;
      default: throw new Error(`path command "${command}" is not supported (use M L H V C Q Z)`);
    }
  }
  return rings.filter((r) => r.length > 2);
}

function shapeRings(tag, a) {
  if (tag === "rect") {
    const x = number(a, "x"), y = number(a, "y"), w = number(a, "width"), h = number(a, "height");
    const r = Math.min(number(a, "rx", attribute(a, "ry") ?? 0), w / 2, h / 2);
    if (r <= 0) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
    const p = [];
    arc(p, x + w - r, y + r, r, -Math.PI / 2, 0); arc(p, x + w - r, y + h - r, r, 0, Math.PI / 2);
    arc(p, x + r, y + h - r, r, Math.PI / 2, Math.PI); arc(p, x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    return [p];
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = number(a, "cx"), cy = number(a, "cy");
    const rx = tag === "circle" ? number(a, "r") : number(a, "rx"), ry = tag === "circle" ? rx : number(a, "ry");
    const p = [];
    arc(p, 0, 0, 1, 0, 2 * Math.PI);
    return [p.map(([u, v]) => [cx + rx * u, cy + ry * v])];
  }
  if (tag === "polygon") {
    const n = (attribute(a, "points") ?? "").trim().split(/[\s,]+/).map(Number);
    return [Array.from({ length: n.length / 2 }, (_, k) => [n[2 * k], n[2 * k + 1]])];
  }
  return pathRings(attribute(a, "d") ?? "");
}

// The shapes of a figure file: their rings, fill, fill rule, the lowest detail level that draws them, their SVG text.
export function loadFigure(path) {
  const svg = readFileSync(path, "utf8");
  if (/\stransform=/.test(svg)) throw new Error(`${path}: transform is not supported, write the coordinates out`);
  return [...svg.matchAll(SHAPE)].filter(([, , a]) => attribute(a, "fill") !== "none").map(([text, tag, a]) => ({
    rings: shapeRings(tag, a),
    colour: parseColour(attribute(a, "fill")),
    evenOdd: attribute(a, "fill-rule") === "evenodd",
    minDetail: number(a, "data-min-detail"),
    // the SVG keeps the full-detail shapes as written, white when they name no fill (an SVG's default is black)
    svg: text.replace(/\sdata-min-detail="[^"]*"/, "").replace(/^<\w+/, (tag) => (attribute(a, "fill") ? tag : `${tag} fill="#ffffff"`)),
  }));
}

// ---- rasterizing: coverage per pixel from SUPERSAMPLE x SUPERSAMPLE samples ----

function coverage(rings, evenOdd, size, transform = (p) => p) {
  const n = size * SUPERSAMPLE, scale = n / UNITS, weight = 1 / (SUPERSAMPLE * SUPERSAMPLE);
  const edges = [];
  for (const ring of rings) {
    const pts = ring.map((p) => transform(p).map((v) => v * scale));
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % pts.length];
      if (y0 !== y1) edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
    }
  }
  const cov = new Float32Array(size * size);
  for (let j = 0; j < n; j++) {
    const sy = j + 0.5;
    const hits = [];
    for (const e of edges) {
      if ((sy >= e.y0 && sy < e.y1) || (sy >= e.y1 && sy < e.y0)) hits.push([e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), e.dir]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    const row = Math.floor(j / SUPERSAMPLE) * size;
    let winding = 0;
    for (let h = 0; h < hits.length - 1; h++) {
      winding = evenOdd ? winding ^ 1 : winding + hits[h][1];
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(hits[h][0] - 0.5)), to = Math.min(n, Math.ceil(hits[h + 1][0] - 0.5));
      for (let i = from; i < to; i++) cov[row + Math.floor(i / SUPERSAMPLE)] += weight;
    }
  }
  return cov;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Paints `cov` over the premultiplied canvas, the colour a function of the pixel's row.
function paint(canvas, cov, size, colourAt) {
  for (let y = 0; y < size; y++) {
    const [r, g, b, a] = colourAt(((y + 0.5) * UNITS) / size);
    for (let x = 0; x < size; x++) {
      const k = y * size + x, alpha = (cov[k] * a) / 255;
      if (alpha <= 0) continue;
      const p = 4 * k, keep = 1 - alpha;
      canvas[p] = r * alpha + canvas[p] * keep;
      canvas[p + 1] = g * alpha + canvas[p + 1] * keep;
      canvas[p + 2] = b * alpha + canvas[p + 2] * keep;
      canvas[p + 3] = alpha + canvas[p + 3] * keep;
    }
  }
}

// The vertical gradient of the square, from its top edge to its bottom edge.
function gradient(top, bottom, detail) {
  const m = GEOMETRY[detail].margin, a = rgb(top), b = rgb(bottom);
  return (y) => {
    const t = Math.min(1, Math.max(0, (y - m) / (UNITS - 2 * m)));
    return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t).concat(255);
  };
}

function render(logo, size) {
  const detail = detailFor(size), g = GEOMETRY[detail];
  const [bodyTop, bodyBottom, edgeTop, edgeBottom] = PALETTES[logo.variant];
  const canvas = new Float32Array(size * size * 4);
  const outer = frameRing(frameAt(detail, logo.notch, 0));
  const inner = frameRing(frameAt(detail, logo.notch, g.border));
  paint(canvas, coverage([outer], false, size), size, gradient(bodyTop, bodyBottom, detail));
  paint(canvas, coverage([outer, inner], true, size), size, gradient(edgeTop, edgeBottom, detail));
  if (detail > 0) {
    const shine = frameRing(frameAt(detail, logo.notch, g.border + HIGHLIGHT_WIDTH));
    paint(canvas, coverage([inner, shine], true, size), size, () => [255, 255, 255, HIGHLIGHT_ALPHA]);
  }
  const k = g.figureScale;
  const place = ([x, y]) => [FIGURE_CENTRE + (x - FIGURE_CENTRE) * k, FIGURE_CENTRE + (y - FIGURE_CENTRE) * k];
  for (const shape of logo.figure.filter((s) => s.minDetail <= detail)) {
    paint(canvas, coverage(shape.rings, shape.evenOdd, size, place), size, () => shape.colour);
  }
  return canvas;
}

// ---- files ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_RGBA = 6, PNG_DEPTH = 8;

// RGBA, 8 bits, every row unfiltered (filter byte 0), the canvas un-premultiplied.
function png(canvas, size) {
  const raw = Buffer.alloc(size * (4 * size + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = 4 * (y * size + x), o = y * (4 * size + 1) + 1 + 4 * x, a = canvas[p + 3];
      for (let i = 0; i < 3; i++) raw[o + i] = a > 0 ? Math.round(Math.min(255, canvas[p + i] / a)) : 0;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = PNG_DEPTH; header[9] = PNG_RGBA;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// An .ico of PNG images (read by every Windows since Vista and by the browsers).
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i, dim = size >= ICO_LARGEST ? 0 : size;
    head[e] = dim; head[e + 1] = dim;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

function svg(logo) {
  const detail = FULL_DETAIL, g = GEOMETRY[detail], [bodyTop, bodyBottom, edgeTop, edgeBottom] = PALETTES[logo.variant];
  const outer = frameSvgPath(frameAt(detail, logo.notch, 0)), inner = frameSvgPath(frameAt(detail, logo.notch, g.border));
  const shine = frameSvgPath(frameAt(detail, logo.notch, g.border + HIGHLIGHT_WIDTH));
  const stops = (id, a, b) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${g.margin}" x2="0" y2="${UNITS - g.margin}">`
    + `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const figure = logo.figure.map((s) => s.svg).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNITS} ${UNITS}" width="${UNITS}" height="${UNITS}">
<defs>${stops("body", bodyTop, bodyBottom)}${stops("edge", edgeTop, edgeBottom)}</defs>
<path d="${outer}" fill="url(#body)"/>
<path d="${outer}${inner}" fill="url(#edge)" fill-rule="evenodd"/>
<path d="${inner}${shine}" fill="#ffffff" fill-opacity="${(HIGHLIGHT_ALPHA / 255).toFixed(3)}" fill-rule="evenodd"/>
${figure}
</svg>
`;
}

// site.json's "logo": { "variant": "amber", "notch": true, "figure": "empty" or "path/to/figure.svg" }
export function readLogo(config, root) {
  const variant = config?.variant ?? "amber";
  if (!PALETTES[variant]) throw new Error(`logo.variant "${variant}": one of ${Object.keys(PALETTES).join(", ")}`);
  const figure = config?.figure ?? "empty";
  return { variant, notch: config?.notch ?? true, figure: figure === "empty" ? [] : loadFigure(resolve(root, figure)) };
}

export const LOGO_FILES = { svg: "logo.svg", ico: "favicon.ico", png: (size) => (size === PNG_SIZES[0] ? "logo.png" : `logo_${size}.png`) };

export function makeLogo(logo, out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, LOGO_FILES.svg), svg(logo));
  for (const size of PNG_SIZES) writeFileSync(join(out, LOGO_FILES.png(size)), png(render(logo, size), size));
  writeFileSync(join(out, LOGO_FILES.ico), ico(ICO_SIZES.map((size) => ({ size, data: png(render(logo, size), size) }))));
}

// The check sheet: every PNG at its own size on a light and on a dark background, the small ones magnified too.
function sheet(out) {
  const row = (bg) => `<div style="background:${bg};padding:16px;display:flex;gap:16px;align-items:end">`
    + PNG_SIZES.map((s) => `<img src="${LOGO_FILES.png(s)}" width="${s}" height="${s}" alt="${s} px">`).join("")
    + PNG_SIZES.filter((s) => s <= 32).map((s) => `<img src="${LOGO_FILES.png(s)}" width="128" height="128" style="image-rendering:pixelated" alt="${s} px, magnified">`).join("")
    + "</div>";
  writeFileSync(join(out, "sizes.html"), `<!doctype html><meta charset="utf-8"><title>Logo sizes</title><body style="margin:0">${row(SHEET_LIGHT)}${row(SHEET_DARK)}</body>\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const wantSheet = args.includes("--sheet");
  const out = resolve(args.find((a) => a !== "--sheet") ?? join(root, "logo-out"));
  try {
    makeLogo(readLogo(JSON.parse(readFileSync(join(root, "site.json"), "utf8")).logo, root), out);
    if (wantSheet) sheet(out);
    console.log(`wrote ${out}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
