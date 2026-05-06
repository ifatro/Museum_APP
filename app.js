const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const runBtn = $("runBtn");
const resetBtn = $("resetBtn");
const previewCanvas = $("previewCanvas");
const overlayCanvas = $("overlayCanvas");
const output = $("output");
const langSelect = $("langSelect");
const scaleSelect = $("scaleSelect");
const modeSelect = $("modeSelect");
const downloadJsonBtn = $("downloadJsonBtn");
const downloadCsvBtn = $("downloadCsvBtn");

const addRegionBtn = $("addRegionBtn");
const deleteRegionBtn = $("deleteRegionBtn");
const clearTemplateBtn = $("clearTemplateBtn");
const exportTemplateBtn = $("exportTemplateBtn");
const importTemplateInput = $("importTemplateInput");
const fieldSelect = $("fieldSelect");
const preprocessSelect = $("preprocessSelect");
const regionsList = $("regionsList");

/** @type {HTMLCanvasElement} */
const canvas = previewCanvas;
/** @type {CanvasRenderingContext2D} */
const ctx = canvas.getContext("2d", { willReadFrequently: true });

/** @type {HTMLCanvasElement} */
const overlay = overlayCanvas;
/** @type {CanvasRenderingContext2D} */
const octx = overlay.getContext("2d", { willReadFrequently: true });

let imageBitmap = null;
let lastResult = null;

const TEMPLATE_STORAGE_KEY = "museum-card-template-v1";

/** @typedef {{ id: string, field: string, rect: { x:number, y:number, w:number, h:number } }} Region */
/** @type {Region[]} */
let regions = [];
let activeRegionId = null;

const FIELD_OPTIONS = [
  { id: "registration_number", label: "מס’ רישום / Registration no." },
  { id: "collection_number", label: "מס’ קבלה / Accession no." },
  { id: "item_number", label: "מס’ ישן / Old no." },
  { id: "museum", label: "מוסד/מוזיאון / Museum" },
  { id: "department", label: "מחלקה / Department" },
  { id: "material", label: "חומר / Material" },
  { id: "technique", label: "טכניקה / Technique" },
  { id: "culture", label: "תרבות / Culture" },
  { id: "period", label: "תקופה / Period" },
  { id: "site", label: "מוצא/אתר / Provenance/Site" },
  { id: "description", label: "תיאור / Description" },
  { id: "height", label: "גובה / Height" },
  { id: "width", label: "רוחב / Width" },
  { id: "diameter", label: "קוטר / Diameter" },
  { id: "notes_handwriting", label: "הערות בכתב יד / Notes (handwriting)" },
  { id: "photo_area", label: "אזור תמונה (לדלג OCR)" },
];

function setBusy(isBusy) {
  runBtn.disabled = isBusy || !imageBitmap;
  fileInput.disabled = isBusy;
  langSelect.disabled = isBusy;
  scaleSelect.disabled = isBusy;
  resetBtn.disabled = isBusy;
  addRegionBtn.disabled = isBusy || !imageBitmap;
  deleteRegionBtn.disabled = isBusy || !activeRegionId;
  exportTemplateBtn.disabled = isBusy || regions.length === 0;
  fieldSelect.disabled = isBusy || !activeRegionId;
  modeSelect.disabled = isBusy || !imageBitmap;
}

function setDownloadsEnabled(enabled) {
  downloadJsonBtn.disabled = !enabled;
  downloadCsvBtn.disabled = !enabled;
}

function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsvRow(values) {
  return values
    .map((v) => {
      const s = `${v ?? ""}`;
      const escaped = s.replaceAll('"', '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function normalizeText(s) {
  return `${s ?? ""}`.replace(/\s+/g, " ").trim();
}

async function loadImage(file) {
  imageBitmap = await createImageBitmap(file);
  drawPreview();
  runBtn.disabled = false;
  output.value = "";
  lastResult = null;
  setDownloadsEnabled(false);
  loadTemplateFromStorage();
  addRegionBtn.disabled = false;
  modeSelect.disabled = false;
  renderRegionsUI();
  drawOverlay();
}

function drawPreview() {
  if (!imageBitmap) return;
  const maxW = 1200;
  const scale = Math.min(1, maxW / imageBitmap.width);
  canvas.width = Math.round(imageBitmap.width * scale);
  canvas.height = Math.round(imageBitmap.height * scale);
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
}

function saveTemplateToStorage() {
  const tpl = { version: 1, regions };
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(tpl));
}

function loadTemplateFromStorage() {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!raw) {
      regions = [];
      activeRegionId = null;
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.regions)) {
      regions = [];
      activeRegionId = null;
      return;
    }
    regions = parsed.regions;
    activeRegionId = regions[0]?.id ?? null;
  } catch {
    regions = [];
    activeRegionId = null;
  }
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function getActiveRegion() {
  return regions.find((r) => r.id === activeRegionId) ?? null;
}

function fieldLabel(fieldId) {
  return FIELD_OPTIONS.find((f) => f.id === fieldId)?.label ?? fieldId;
}

function renderFieldSelect() {
  fieldSelect.innerHTML = "";
  for (const opt of FIELD_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    fieldSelect.appendChild(o);
  }
  const active = getActiveRegion();
  fieldSelect.value = active?.field ?? FIELD_OPTIONS[0].id;
  fieldSelect.disabled = !active;
}

function renderRegionsUI() {
  renderFieldSelect();
  deleteRegionBtn.disabled = !activeRegionId;
  exportTemplateBtn.disabled = regions.length === 0;

  regionsList.innerHTML = "";
  for (const r of regions) {
    const row = document.createElement("div");
    row.className = "regionRow" + (r.id === activeRegionId ? " regionRow--active" : "");
    const left = document.createElement("div");
    left.className = "regionRow__left";
    const name = document.createElement("div");
    name.className = "regionRow__name";
    name.textContent = fieldLabel(r.field);
    const meta = document.createElement("div");
    meta.className = "regionRow__meta";
    meta.textContent = `x:${r.rect.x.toFixed(3)} y:${r.rect.y.toFixed(3)} w:${r.rect.w.toFixed(3)} h:${r.rect.h.toFixed(3)}`;
    left.appendChild(name);
    left.appendChild(meta);
    const btn = document.createElement("button");
    btn.className = "regionRow__btn";
    btn.textContent = "Select";
    btn.addEventListener("click", () => {
      activeRegionId = r.id;
      renderRegionsUI();
      drawOverlay();
    });
    row.appendChild(left);
    row.appendChild(btn);
    regionsList.appendChild(row);
  }
}

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!imageBitmap) return;

  for (const r of regions) {
    const px = normToPxRect(r.rect);
    const isActive = r.id === activeRegionId;
    octx.save();
    octx.lineWidth = isActive ? 3 : 2;
    octx.strokeStyle = isActive ? "rgba(110,168,254,.95)" : "rgba(255,255,255,.65)";
    octx.fillStyle = isActive ? "rgba(110,168,254,.16)" : "rgba(255,255,255,.08)";
    octx.fillRect(px.x, px.y, px.w, px.h);
    octx.strokeRect(px.x, px.y, px.w, px.h);

    // label
    const label = fieldLabel(r.field);
    octx.font = "12px ui-sans-serif, system-ui, Segoe UI, Arial";
    const pad = 6;
    const tw = octx.measureText(label).width;
    const boxW = Math.min(px.w, tw + pad * 2);
    const boxH = 18;
    octx.fillStyle = isActive ? "rgba(110,168,254,.95)" : "rgba(0,0,0,.55)";
    octx.fillRect(px.x, Math.max(0, px.y - boxH), boxW, boxH);
    octx.fillStyle = isActive ? "#071022" : "rgba(255,255,255,.9)";
    octx.fillText(label, px.x + pad, Math.max(12, px.y - 6));

    if (isActive) drawHandles(px);
    octx.restore();
  }
}

function drawHandles(px) {
  const size = 8;
  const points = [
    { x: px.x, y: px.y },
    { x: px.x + px.w, y: px.y },
    { x: px.x, y: px.y + px.h },
    { x: px.x + px.w, y: px.y + px.h },
  ];
  octx.fillStyle = "rgba(110,168,254,.95)";
  for (const p of points) {
    octx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normToPxRect(nr) {
  return {
    x: nr.x * overlay.width,
    y: nr.y * overlay.height,
    w: nr.w * overlay.width,
    h: nr.h * overlay.height,
  };
}

function pxToNormPoint(px, py) {
  return {
    x: clamp01(px / overlay.width),
    y: clamp01(py / overlay.height),
  };
}

function normalizeRect(r) {
  const x1 = clamp01(r.x);
  const y1 = clamp01(r.y);
  const x2 = clamp01(r.x + r.w);
  const y2 = clamp01(r.y + r.h);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function hitTestHandle(region, px, py) {
  const pr = normToPxRect(region.rect);
  const size = 10;
  const handles = [
    { id: "nw", x: pr.x, y: pr.y },
    { id: "ne", x: pr.x + pr.w, y: pr.y },
    { id: "sw", x: pr.x, y: pr.y + pr.h },
    { id: "se", x: pr.x + pr.w, y: pr.y + pr.h },
  ];
  for (const h of handles) {
    if (Math.abs(px - h.x) <= size && Math.abs(py - h.y) <= size) return h.id;
  }
  // inside rect
  if (px >= pr.x && px <= pr.x + pr.w && py >= pr.y && py <= pr.y + pr.h) return "move";
  return null;
}

function canvasPointFromEvent(e) {
  const rect = overlay.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * overlay.width;
  const y = ((e.clientY - rect.top) / rect.height) * overlay.height;
  return { x, y };
}

let drawMode = "idle"; // idle | creating | editing
let drag = null; // { type: 'create'|'move'|'resize', handle?, startPx, startRectNorm, regionId }

function setActiveRegion(id) {
  activeRegionId = id;
  renderRegionsUI();
  drawOverlay();
}

function beginCreateRegion() {
  const id = uid();
  const r = {
    id,
    field: FIELD_OPTIONS[0].id,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  };
  regions = [r, ...regions];
  setActiveRegion(id);
  saveTemplateToStorage();
}

function deleteActiveRegion() {
  if (!activeRegionId) return;
  regions = regions.filter((r) => r.id !== activeRegionId);
  activeRegionId = regions[0]?.id ?? null;
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
}

function clearTemplate() {
  regions = [];
  activeRegionId = null;
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
}

function exportTemplate() {
  const tpl = { version: 1, regions };
  downloadText("museum-card-template.json", JSON.stringify(tpl, null, 2), "application/json");
}

async function importTemplateFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.regions)) throw new Error("Bad template file");
  regions = parsed.regions;
  activeRegionId = regions[0]?.id ?? null;
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
}

function applyPreprocessToCanvas(srcCanvas) {
  const mode = preprocessSelect.value;
  if (mode === "none") return srcCanvas;

  const c = document.createElement("canvas");
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;
  const cctx = c.getContext("2d", { willReadFrequently: true });
  cctx.drawImage(srcCanvas, 0, 0);

  const img = cctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // simple luminance
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    d[i] = lum;
    d[i + 1] = lum;
    d[i + 2] = lum;
  }

  if (mode === "gray") {
    cctx.putImageData(img, 0, 0);
    return c;
  }

  // auto / bw threshold
  // Compute mean lum for a lightweight threshold.
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  const mean = sum / (d.length / 4);
  const threshold = mode === "bw" ? 175 : Math.min(195, Math.max(140, mean + 15));

  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  cctx.putImageData(img, 0, 0);
  return c;
}

async function runOcrWholeImage() {
  if (!imageBitmap) return;

  setBusy(true);
  output.value = "Running OCR locally...\n";

  const lang = langSelect.value;
  const scale = Number(scaleSelect.value);

  // Render into an offscreen canvas at desired scale.
  const off = document.createElement("canvas");
  off.width = Math.round(imageBitmap.width * scale);
  off.height = Math.round(imageBitmap.height * scale);
  const offCtx = off.getContext("2d", { willReadFrequently: true });
  offCtx.drawImage(imageBitmap, 0, 0, off.width, off.height);

  const worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m?.status) {
        const pct = typeof m.progress === "number" ? ` ${(m.progress * 100).toFixed(0)}%` : "";
        output.value = `Running OCR locally...\n${m.status}${pct}\n`;
      }
    },
  });

  try {
    // Help mixed Hebrew/English readability.
    await worker.setParameters({
      preserve_interword_spaces: "1",
    });

    const { data } = await worker.recognize(off);

    const extracted = {
      meta: {
        mode: "whole_image",
        lang,
        scale,
        createdAt: new Date().toISOString(),
      },
      text: normalizeText(data.text),
      confidence: data.confidence,
    };

    lastResult = extracted;
    output.value = JSON.stringify(extracted, null, 2);
    setDownloadsEnabled(true);
  } finally {
    await worker.terminate();
    setBusy(false);
  }
}

async function runOcrTemplate() {
  if (!imageBitmap) return;
  if (regions.length === 0) {
    output.value = "No template regions defined. Add fields first, or switch to Whole image.\n";
    return;
  }

  setBusy(true);
  output.value = "Running OCR (template) locally...\n";

  const lang = langSelect.value;
  const scale = Number(scaleSelect.value);

  const worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m?.status) {
        const pct = typeof m.progress === "number" ? ` ${(m.progress * 100).toFixed(0)}%` : "";
        output.value = `Running OCR (template) locally...\n${m.status}${pct}\n`;
      }
    },
  });

  try {
    await worker.setParameters({
      preserve_interword_spaces: "1",
    });

    const results = [];
    let idx = 0;
    const ocrTargets = regions.filter((r) => r.field !== "photo_area");
    for (const r of ocrTargets) {
      idx += 1;
      output.value = `Running OCR (template) locally...\nField ${idx}/${ocrTargets.length}: ${fieldLabel(r.field)}\n`;

      const roi = regionToCanvas(r.rect, scale);
      const pre = applyPreprocessToCanvas(roi);

      const { data } = await worker.recognize(pre);
      results.push({
        field: r.field,
        label: fieldLabel(r.field),
        text: normalizeText(data.text),
        confidence: data.confidence,
        rect: r.rect,
      });
    }

    const extracted = {
      meta: {
        mode: "template",
        lang,
        scale,
        preprocess: preprocessSelect.value,
        createdAt: new Date().toISOString(),
      },
      fields: Object.fromEntries(results.map((r) => [r.field, r.text])),
      fieldDetails: results,
    };

    lastResult = extracted;
    output.value = JSON.stringify(extracted, null, 2);
    setDownloadsEnabled(true);
  } finally {
    await worker.terminate();
    setBusy(false);
  }
}

function regionToCanvas(normRect, scale) {
  const sx = Math.round(normRect.x * imageBitmap.width);
  const sy = Math.round(normRect.y * imageBitmap.height);
  const sw = Math.round(normRect.w * imageBitmap.width);
  const sh = Math.round(normRect.h * imageBitmap.height);

  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(sw * scale));
  off.height = Math.max(1, Math.round(sh * scale));
  const offCtx = off.getContext("2d", { willReadFrequently: true });
  offCtx.drawImage(imageBitmap, sx, sy, sw, sh, 0, 0, off.width, off.height);
  return off;
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadImage(file);
});

runBtn.addEventListener("click", () => {
  const mode = modeSelect.value;
  if (mode === "whole") return runOcrWholeImage();
  return runOcrTemplate();
});

addRegionBtn.addEventListener("click", () => {
  if (!imageBitmap) return;
  beginCreateRegion();
});

deleteRegionBtn.addEventListener("click", () => deleteActiveRegion());
clearTemplateBtn.addEventListener("click", () => clearTemplate());
exportTemplateBtn.addEventListener("click", () => exportTemplate());

importTemplateInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await importTemplateFile(file);
  } catch (err) {
    output.value = `Failed to import template: ${err?.message ?? err}\n`;
  } finally {
    importTemplateInput.value = "";
  }
});

fieldSelect.addEventListener("change", () => {
  const active = getActiveRegion();
  if (!active) return;
  active.field = fieldSelect.value;
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
});

resetBtn.addEventListener("click", () => {
  fileInput.value = "";
  imageBitmap = null;
  lastResult = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  output.value = "";
  runBtn.disabled = true;
  setDownloadsEnabled(false);
  regions = [];
  activeRegionId = null;
  addRegionBtn.disabled = true;
  deleteRegionBtn.disabled = true;
  exportTemplateBtn.disabled = true;
  fieldSelect.disabled = true;
  modeSelect.disabled = true;
  regionsList.innerHTML = "";
});

downloadJsonBtn.addEventListener("click", () => {
  if (!lastResult) return;
  downloadText("museum-card.json", JSON.stringify(lastResult, null, 2), "application/json");
});

downloadCsvBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const mode = lastResult?.meta?.mode;
  if (mode === "template") {
    const fields = lastResult.fields ?? {};
    const keys = Object.keys(fields);
    const headers = keys;
    const row = keys.map((k) => fields[k]);
    const csv = `${toCsvRow(headers)}\n${toCsvRow(row)}\n`;
    downloadText("museum-card.csv", csv, "text/csv");
    return;
  }
  const headers = ["text", "confidence"];
  const row = [lastResult.text, lastResult.confidence];
  const csv = `${toCsvRow(headers)}\n${toCsvRow(row)}\n`;
  downloadText("museum-card.csv", csv, "text/csv");
});

// UX: drag & drop
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return;
  await loadImage(file);
});

// Overlay interactions: create/move/resize regions
overlay.addEventListener("mousedown", (e) => {
  if (!imageBitmap) return;
  const { x, y } = canvasPointFromEvent(e);

  // hit test existing regions (active first)
  const candidates = [
    ...(activeRegionId ? regions.filter((r) => r.id === activeRegionId) : []),
    ...regions.filter((r) => r.id !== activeRegionId),
  ];
  for (const r of candidates) {
    const hit = hitTestHandle(r, x, y);
    if (!hit) continue;
    setActiveRegion(r.id);
    const startRectNorm = { ...r.rect };
    const startPx = { x, y };
    if (hit === "move") {
      drag = { type: "move", regionId: r.id, startRectNorm, startPx };
    } else {
      drag = { type: "resize", handle: hit, regionId: r.id, startRectNorm, startPx };
    }
    drawMode = "editing";
    return;
  }

  // start creating a new region (if none hit)
  const id = uid();
  const p = pxToNormPoint(x, y);
  const r = {
    id,
    field: FIELD_OPTIONS[0].id,
    rect: { x: p.x, y: p.y, w: 0.001, h: 0.001 },
  };
  regions = [r, ...regions];
  setActiveRegion(id);
  drag = { type: "create", regionId: id, startRectNorm: { ...r.rect }, startPx: { x, y } };
  drawMode = "creating";
  saveTemplateToStorage();
});

window.addEventListener("mousemove", (e) => {
  if (!drag || !imageBitmap) return;
  const { x, y } = canvasPointFromEvent(e);
  const region = regions.find((r) => r.id === drag.regionId);
  if (!region) return;

  const dx = (x - drag.startPx.x) / overlay.width;
  const dy = (y - drag.startPx.y) / overlay.height;

  if (drag.type === "create") {
    region.rect = normalizeRect({
      x: drag.startRectNorm.x,
      y: drag.startRectNorm.y,
      w: dx,
      h: dy,
    });
  } else if (drag.type === "move") {
    region.rect = normalizeRect({
      x: drag.startRectNorm.x + dx,
      y: drag.startRectNorm.y + dy,
      w: drag.startRectNorm.w,
      h: drag.startRectNorm.h,
    });
  } else if (drag.type === "resize") {
    const r0 = drag.startRectNorm;
    let x1 = r0.x;
    let y1 = r0.y;
    let x2 = r0.x + r0.w;
    let y2 = r0.y + r0.h;
    if (drag.handle.includes("n")) y1 = r0.y + dy;
    if (drag.handle.includes("s")) y2 = r0.y + r0.h + dy;
    if (drag.handle.includes("w")) x1 = r0.x + dx;
    if (drag.handle.includes("e")) x2 = r0.x + r0.w + dx;
    region.rect = normalizeRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }

  drawOverlay();
  renderRegionsUI();
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  drag = null;
  drawMode = "idle";
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
});

