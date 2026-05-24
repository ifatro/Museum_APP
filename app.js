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
const notesCloudOcrCheckbox = $("notesCloudOcrCheckbox");
const notesOcrApiInput = $("notesOcrApiInput");

const NOTES_CLOUD_OCR_STORAGE_KEY = "museum-notes-cloud-ocr-v1";
const DEFAULT_NOTES_OCR_API = "http://localhost:3921";

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

const CARD_FORM_FIELDS = [
  { id: "registration_number", label: "מס' רשום" },
  { id: "collection_number", label: "מס' קבלה" },
  { id: "item_number", label: "מס' ישן" },
  { id: "material", label: "חומר" },
  { id: "typology", label: "טפוס" },
  { id: "period", label: "תקופה" },
  { id: "height", label: "גובה" },
  { id: "width", label: "רוחב" },
  { id: "diameter", label: "קוטר" },
  { id: "location", label: "מוצא" },
  { id: "object_location_museum", label: "מקום החפץ במוזיאון" },
  { id: "description", label: "תיאור" },
  { id: "notes", label: "הערות" },
];
const CARD_FIELD_IDS = CARD_FORM_FIELDS.map((f) => f.id);
const TALL_TEXTAREA_FIELD_IDS = new Set(["typology", "period", "notes"]);
/** מקום במוזיאון + תיאור — עמודה מלאה, תיאור מתחת */
const MUSEUM_DESC_STACK_IDS = ["object_location_museum", "description"];
const MUSEUM_DESC_STACK_ID_SET = new Set(MUSEUM_DESC_STACK_IDS);
const FIELD_OPTIONS = [...CARD_FORM_FIELDS, { id: "photo_area", label: "אזור תמונה (לדלג על OCR)" }];

const DIM_METRICS_IDS = ["height", "width", "diameter"];
const DIM_METRICS_ID_SET = new Set(DIM_METRICS_IDS);

const LEGACY_FIELD_MAP = {
  museum: "location",
  department: "object_location_museum",
  site: "location",
  technique: "material",
  culture: "period",
  notes_handwriting: "notes",
};

function setBusy(isBusy) {
  runBtn.disabled = isBusy || !imageBitmap;
  fileInput.disabled = isBusy;
  langSelect.disabled = isBusy;
  scaleSelect.disabled = isBusy;
  resetBtn.disabled = isBusy;
  addRegionBtn.disabled = isBusy || !imageBitmap;
  deleteRegionBtn.disabled = isBusy || !activeRegionId;
  exportTemplateBtn.disabled = isBusy || regions.length === 0;
  if (fieldSelect) fieldSelect.disabled = isBusy || !imageBitmap;
  if (notesCloudOcrCheckbox) notesCloudOcrCheckbox.disabled = isBusy;
  if (notesOcrApiInput) notesOcrApiInput.disabled = isBusy;
  modeSelect.disabled = isBusy || !imageBitmap;
  for (const id of CARD_FIELD_IDS) {
    const el = $(`cf_${id}`);
    if (el) el.disabled = isBusy;
  }
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

function normalizeLongText(s) {
  return `${s ?? ""}`
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** שדות שמקבלים תיקון מילון י׳/ל׳ אחרי OCR */
const HEBREW_LAMED_YOD_FIELD_IDS = new Set([
  "description",
  "notes",
  "typology",
  "period",
  "material",
  "location",
  "object_location_museum",
]);

/** פסקאות עברית ארוכות — פרופיל OCR נפרד */
const HEBREW_PARAGRAPH_FIELD_IDS = new Set(["notes", "description"]);

const HEBREW_WORD_RX = /[\u0590-\u05FF]+/g;

let hebrewLexiconWords = new Set();
let hebrewLexiconReplacements = [];
let hebrewLexiconLoadPromise = null;

function buildHebrewLexiconIndex(data) {
  const words = new Set();
  for (const w of data?.words ?? []) {
    const t = `${w ?? ""}`.trim();
    if (t) words.add(t);
  }
  for (const pair of data?.replacements ?? []) {
    if (Array.isArray(pair) && pair[1]) words.add(`${pair[1]}`.trim());
  }
  const replacements = (data?.replacements ?? [])
    .filter((p) => Array.isArray(p) && p[0] && p[1])
    .map(([from, to]) => ({ from: `${from}`, to: `${to}` }))
    .sort((a, b) => b.from.length - a.from.length);
  hebrewLexiconWords = words;
  hebrewLexiconReplacements = replacements;
}

async function loadHebrewOcrLexicon() {
  if (!hebrewLexiconLoadPromise) {
    hebrewLexiconLoadPromise = (async () => {
      try {
        const res = await fetch("./hebrew-ocr-lexicon.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buildHebrewLexiconIndex(await res.json());
      } catch {
        buildHebrewLexiconIndex({ version: 1, words: [], replacements: [] });
      }
    })();
  }
  return hebrewLexiconLoadPromise;
}

function hebrewCharRatio(text) {
  const s = `${text ?? ""}`;
  const he = (s.match(/[\u0590-\u05FF]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return he / (he + lat + 1);
}

function lamedYodSingleSwapVariants(word) {
  const variants = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "ל") variants.push(word.slice(0, i) + "י" + word.slice(i + 1));
    else if (ch === "י") variants.push(word.slice(0, i) + "ל" + word.slice(i + 1));
  }
  return variants;
}

function fixHebrewWordWithLexicon(word) {
  if (!word || hebrewLexiconWords.has(word)) return word;
  const candidates = lamedYodSingleSwapVariants(word).filter((v) => hebrewLexiconWords.has(v));
  return candidates.length === 1 ? candidates[0] : word;
}

function applyHebrewOcrLexicon(text) {
  let t = `${text ?? ""}`;
  for (const { from, to } of hebrewLexiconReplacements) {
    if (t.includes(from)) t = t.split(from).join(to);
  }
  if (hebrewLexiconWords.size === 0) return t;
  return t.replace(HEBREW_WORD_RX, (word) => fixHebrewWordWithLexicon(word));
}

function applyHebrewFieldCorrection(fieldId, text) {
  if (!HEBREW_LAMED_YOD_FIELD_IDS.has(fieldId)) return text;
  if (hebrewCharRatio(text) < 0.25) return text;
  return applyHebrewOcrLexicon(text);
}

/** @deprecated — use applyHebrewFieldCorrection */
function fixHebrewLamedYodConfusions(text) {
  return applyHebrewOcrLexicon(text);
}


/** --- חילוץ Whole image + ניקוי OCR --- */
const WHOLE_IMAGE_PATTERNS_ORDERED = [
  [
    "object_location_museum",
    [
      /(?:^|\n)[^\S\n]*מקום\s*החפץ\s*במוזי?און\s*[:\-–]?\s*([^\n]+)/im,
      /(?:^|\n)[^\S\n]*מקום\s*החפץ\s*במוזי?אום\s*[:\-–]?\s*([^\n]+)/im,
    ],
  ],
  [
    "registration_number",
    [
      /(?:^|\n)[^\S\n]*(?:מספר|מס)['׳״]?\s*רשו?ם\s*[:\-–]?\s*([^\n]+)/im,
      /(?:^|\n)[^\S\n]*רשו?ם\s*[:\-–]?\s*([^\n]+)/im,
    ],
  ],
  ["collection_number", [/(?:^|\n)[^\S\n]*(?:מספר|מס)['׳״]?\s*קבלה\s*[:\-–]?\s*([^\n]+)/im]],
  ["item_number", [/(?:^|\n)[^\S\n]*(?:מספר|מס)['׳״]?\s*ישן\s*[:\-–]?\s*([^\n]+)/im]],
  ["material", [/(?:^|\n)[^\S\n]*חומר\s*[:\-–]?\s*([^\n]+)/im]],
  ["typology", [/(?:^|\n)[^\S\n]*(?:טפוס|טיפוס)\s*[:\-–]?\s*([^\n]+)/im]],
  ["period", [/(?:^|\n)[^\S\n]*תקופה\s*[:\-–]?\s*([^\n]+)/im]],
  ["height", [/(?:^|\n)[^\S\n]*גובה\s*[:\-–]?\s*([^\n]+)/im]],
  ["width", [/(?:^|\n)[^\S\n]*רוחב\s*[:\-–]?\s*([^\n]+)/im]],
  ["diameter", [/(?:^|\n)[^\S\n]*קוטר\s*[:\-–]?\s*([^\n]+)/im]],
  [
    "location",
    [
      /(?:^|\n)[^\S\n]*מוצא\s*[:\-–]?\s*([^\n]+)/im,
      /(?:^|\n)[^\S\n]*מקום\s*[:\-–]\s*([^\n]+)/im,
    ],
  ],
  ["description", [/(?:^|\n)[^\S\n]*תיאור\s*[:\-–]?\s*([^\n]+)/im]],
  ["notes", [/(?:^|\n)[^\S\n]*הערות\s*[:\-–]?\s*([^\n]+)/im]],
];

const WHOLE_IMAGE_PATTERNS_BY_FIELD = Object.fromEntries(WHOLE_IMAGE_PATTERNS_ORDERED);
const FIELD_OPTION_TAGS = FIELD_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join("");
const MIN_REGION_SIZE = 0.008;

function patternsForField(fieldId) {
  return WHOLE_IMAGE_PATTERNS_BY_FIELD[fieldId] ?? [];
}

function normalizeOcrQuotes(s) {
  return `${s ?? ""}`.replace(/[\u2018\u2019\u0060\u00B4\u201D\u201C]/g, "'").replace(/\r\n/g, "\n");
}

function firstRegexCapture(text, patterns) {
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m?.[1]) return normalizeText(stripFrameArtifacts(m[1]));
  }
  return "";
}

/** קווים אנכיים / מפרידים מקווי טבלה ב-OCR */
function stripRoiDividerArtifacts(s) {
  return `${s ?? ""}`
    .replace(/[|｜│┃║┆┊┇¦❘∣▏׀\u05C0\uFF5C\u01C0\u2758]/g, "")
    .replace(/[\/\\]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** נקודות זוטרות מפינות/מסגרת — לא מספרים עשרוניים (2.4) */
function stripFramePeriodArtifacts(s) {
  let t = `${s ?? ""}`.trim();
  if (!t) return "";
  if (/^[.:|｜\-–—'"׳״\s]+$/.test(t)) return "";
  t = t.replace(/\s+[.:|｜\-–—]+\s+/g, " ").trim();
  t = t.replace(/([^\d])\.+$/gu, "$1").trim();
  t = t.replace(/^\.+(?=\s|$)/g, "").trim();
  return t;
}

/** רווחים ומסגרת — עקרונות museum-app-core.mdc */
function polishFieldSpacing(fieldId, value) {
  const v = stripFrameArtifacts(String(value ?? ""));
  if (!v) return "";
  return fieldId === "description" || fieldId === "notes" ? normalizeLongText(v) : normalizeText(v);
}

function stripFrameArtifacts(s) {
  return stripFramePeriodArtifacts(stripRoiDividerArtifacts(s));
}

/** M + 2 אותיות לטיניות + רווח + 5 ספרות (למשל MHP 72958) */
const REGISTRATION_DISPLAY = /^M[A-Z]{2}\s\d{5}$/;
const REGISTRATION_COMPACT = /^M[A-Z]{2}\d{5}$/;

function compactOkRegistration(value) {
  const t = `${value ?? ""}`.trim().replace(/\s+/g, " ");
  if (REGISTRATION_DISPLAY.test(t)) return t;
  const c = t.replace(/\s/g, "").toUpperCase();
  if (!REGISTRATION_COMPACT.test(c)) return null;
  return `M${c.slice(1, 3)} ${c.slice(3)}`;
}

function registrationDigitsPart(display) {
  const c = compactOkRegistration(display);
  return c ? c.replace(/\s/g, "").slice(3) : "";
}

function registrationLettersPart(display) {
  const c = compactOkRegistration(display);
  return c ? c.replace(/\s/g, "").slice(1, 3) : "";
}

/** בשדה מס' רשום: אותן 5 ספרות — MHP גובר על MEP (טעות OCR נפוצה) */
function registrationCandidateScore(display) {
  const c = compactOkRegistration(display);
  if (!c) return -Infinity;
  let score = 1000;
  const letters = registrationLettersPart(c);
  if (letters === "HP") score += 500;
  else if (letters === "EP") score -= 400;
  return score;
}

function preferRegistrationCandidate(a, b) {
  const ca = compactOkRegistration(a);
  const cb = compactOkRegistration(b);
  if (!ca) return cb || "";
  if (!cb) return ca;
  const da = registrationDigitsPart(ca);
  const db = registrationDigitsPart(cb);
  if (da === db && da.length === 5) {
    return registrationCandidateScore(ca) >= registrationCandidateScore(cb) ? ca : cb;
  }
  return registrationCandidateScore(ca) >= registrationCandidateScore(cb) ? ca : cb;
}

function looksLikeRegistrationNumber(value) {
  return Boolean(compactOkRegistration(formatRegistrationNumberFromRaw(String(value ?? ""))));
}

/** שורה של קבלה/ישן בלי רשום — לא לחלץ ממנה מס' רשום */
function lineIsOtherIdField(line) {
  const hasRashom = /רשו?ם/i.test(line);
  if (/קבלה/i.test(line) && !hasRashom) return true;
  if (/ישן/i.test(line) && !hasRashom) return true;
  return false;
}

/** בוחר MXX ##### מהשורה עם "רשום", לא מהתאמה הראשונה בכל הדף */
function pickBestRegistrationFromText(text) {
  const lines = `${text ?? ""}`.split(/\n/);
  let best = null;
  let bestScore = -Infinity;
  for (const line of lines) {
    if (lineIsOtherIdField(line)) continue;
    const got = formatRegistrationNumberFromRaw(line);
    if (!got) continue;
    let score = 0;
    if (/רשו?ם/i.test(line)) score += 200;
    if (/קבלה/i.test(line)) score -= 100;
    if (/ישן/i.test(line)) score -= 100;
    if (score > bestScore) {
      bestScore = score;
      best = got;
    } else if (score === bestScore && best) {
      best = preferRegistrationCandidate(best, got);
    } else if (!best) {
      best = got;
    }
  }
  if (best) return best;
  if (!lineIsOtherIdField(text)) {
    const all = collectRegistrationCandidatesFromText(text);
    return all.length ? pickBestRegistrationCandidate(all) : null;
  }
  return null;
}

function collectRegistrationCandidatesFromText(text) {
  const found = [];
  const add = (v) => {
    const c = compactOkRegistration(v);
    if (c && !found.includes(c)) found.push(c);
  };
  const blob = `${text ?? ""}`;
  for (const line of blob.split(/\n/)) {
    if (lineIsOtherIdField(line)) continue;
    add(pickRegistrationFromFlat(line.replace(/\s+/g, "")));
    add(extractRegistrationLoose(line));
  }
  add(pickRegistrationFromFlat(blob.replace(/\s+/g, "")));
  add(extractRegistrationLoose(blob));
  const flat = blob.replace(/\s/g, "");
  for (const m of flat.matchAll(/M([A-Za-z]{2})(\d{5})/gi)) {
    add(`M${m[1].toUpperCase()} ${m[2]}`);
  }
  return found;
}

function pickBestRegistrationCandidate(candidates) {
  let best = "";
  for (const c of candidates) {
    best = best ? preferRegistrationCandidate(best, c) : c;
  }
  return best || null;
}

function canonicalRegistration(value, fullPageText = "") {
  const primary = stripKnownLabelPrefix("registration_number", stripFrameArtifacts(String(value ?? "")));
  const fromRoi = pickBestRegistrationFromText(primary) || compactOkRegistration(formatRegistrationNumberFromRaw(primary));
  if (fromRoi) return fromRoi;
  const full = stripFrameArtifacts(String(fullPageText ?? ""));
  if (!full || full === primary) return "";
  return pickBestRegistrationFromText(full) || "";
}

function registrationMergeScore(text) {
  const c = canonicalRegistration(text, "");
  if (c) return registrationCandidateScore(c);
  const flat = `${text ?? ""}`.replace(/\s/g, "");
  const m = flat.match(/M[A-Za-z]{2}\d{5}/i);
  return m ? 100 + m[0].length : flat.length;
}

function mergeCardFieldValue(fieldId, prev, next) {
  const a = `${prev ?? ""}`.trim();
  const b = `${next ?? ""}`.trim();
  if (fieldId === "registration_number") {
    const ca = canonicalRegistration(a, "");
    const cb = canonicalRegistration(b, "");
    if (ca && cb) return preferRegistrationCandidate(ca, cb);
    if (ca) return ca;
    if (cb) return cb;
    const combined = canonicalRegistration(`${a}\n${b}`, "");
    return combined || "";
  }
  if (!a) return b;
  if (!b) return a;
  return b.length >= a.length ? b : a;
}

function rescueRegistrationField(primary, contextBlob = "") {
  const roi = stripFrameArtifacts(String(primary ?? ""));
  const roiCandidates = collectRegistrationCandidatesFromText(roi);
  let v = roiCandidates.length ? pickBestRegistrationCandidate(roiCandidates) : "";
  if (v) return v;
  v = pickBestRegistrationFromText(roi);
  if (v) return v;
  const labelHit = firstRegexCapture(roi, patternsForField("registration_number"));
  if (labelHit) {
    v =
      pickBestRegistrationFromText(labelHit) || compactOkRegistration(formatRegistrationNumberFromRaw(labelHit));
    if (v) return v;
  }
  const ctx = stripFrameArtifacts(String(contextBlob ?? ""));
  if (ctx && ctx !== roi) {
    const ctxCandidates = collectRegistrationCandidatesFromText(ctx);
    v = ctxCandidates.length ? pickBestRegistrationCandidate(ctxCandidates) : "";
    if (!v) v = pickBestRegistrationFromText(ctx);
    if (v) return preferRegistrationCandidate(v, pickBestRegistrationFromText(roi) || v);
  }
  return "";
}

function finalizeCollectionNumber(raw) {
  let v = stripKnownLabelPrefix("collection_number", stripFrameArtifacts(String(raw ?? "")));
  v = normalizeText(v);
  if (!v || isLabelOnlyValue("collection_number", v)) return "";
  if (looksLikeRegistrationNumber(v)) return "";
  const slash = v.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (slash) return polishFieldSpacing("collection_number", `${slash[1]}/${slash[2]}`);
  const digitsOnly = v.replace(/[Oo]/g, "0").match(/\d{2,5}/);
  if (digitsOnly && !/[A-Za-z]{2,}/.test(v.replace(/[\d\s/]/g, ""))) {
    return polishFieldSpacing("collection_number", digitsOnly[0]);
  }
  return collectionNumberLooksPlausible(v) ? polishFieldSpacing("collection_number", v) : "";
}

function finalizeItemNumber(raw) {
  let v = stripItemNumberOcrGunk(stripFrameArtifacts(String(raw ?? "")));
  if (!v || looksLikeRegistrationNumber(v)) return "";
  const parts = v.split(/[:：]/);
  if (parts.length > 1) v = parts[parts.length - 1].trim();
  const colonOld = v.match(/ישן\s*[:\-–]?\s*(\d{3,5}[A-Za-z]?)/i);
  if (colonOld) return polishFieldSpacing("item_number", colonOld[1]);
  const digits = v.match(/\b(\d{3,5}[A-Za-z]?)\b/);
  if (digits && !looksLikeRegistrationNumber(digits[0])) {
    return polishFieldSpacing("item_number", digits[1]);
  }
  const wm = v.match(/\bW\s*M\s*(\d{3,5})\s*([A-Za-z])?\b/i);
  if (wm) {
    const suffix = wm[2] ? wm[2].toUpperCase() : "";
    return polishFieldSpacing("item_number", `WM ${wm[1]}${suffix}`.trim());
  }
  const compactWm = v.replace(/\s/g, "").match(/\bWM(\d{3,5})([A-Za-z])?\b/i);
  if (compactWm) {
    const suffix = compactWm[2] ? compactWm[2].toUpperCase() : "";
    return polishFieldSpacing("item_number", `WM ${compactWm[1]}${suffix}`.trim());
  }
  if (isLabelOnlyValue("item_number", v)) return "";
  return polishFieldSpacing("item_number", v);
}

function finalizePeriodValue(raw) {
  let v = stripKnownLabelPrefix("period", stripFrameArtifacts(String(raw ?? "")));
  v = normalizeText(v);
  if (!v || isLabelOnlyValue("period", v)) return "";
  const dup = v.match(/^(.{10,})\s+\1/);
  if (dup) v = dup[1].trim();
  v = v.replace(/מאה\s+ו\s+לסה/g, "מאה א' לסה");
  v = v.replace(/מאה\s+I\s+לסה"נ/gi, "מאה א' לסה\"נ");
  v = v.replace(/לסה"ב/g, 'לסה"נ');
  v = v.replace(/לסה"נ\./g, 'לסה"נ');
  return polishFieldSpacing("period", applyHebrewFieldCorrection("period", v));
}

function normalizeMaterialText(v) {
  let t = normalizeText(v);
  t = t.replace(/חרס\s*מזוגג/g, "חרס מזוגג");
  t = t.replace(/חרסמזוגג/g, "חרס מזוגג");
  return t;
}

function finalizeTypology(raw) {
  let v = stripKnownLabelPrefix("typology", stripFrameArtifacts(String(raw ?? "")));
  v = normalizeText(v);
  if (!v || isLabelOnlyValue("typology", v)) return "";
  return applyHebrewFieldCorrection("typology", polishFieldSpacing("typology", v));
}

function finalizeLongTextField(fieldId, raw) {
  let v = stripKnownLabelPrefix(fieldId, stripFrameArtifacts(String(raw ?? "")));
  v = normalizeLongText(v);
  v = applyHebrewFieldCorrection(fieldId, v);
  if (!v || isLabelOnlyValue(fieldId, v)) return "";
  return polishFieldSpacing(fieldId, v);
}

function finalizeLocationField(fieldId, raw) {
  let v = stripKnownLabelPrefix(fieldId, stripFrameArtifacts(String(raw ?? "")));
  v = normalizeText(v);
  if (!v || isLabelOnlyValue(fieldId, v)) return "";
  return polishFieldSpacing(fieldId, applyHebrewFieldCorrection(fieldId, v));
}

function fixDimensionDigitAmbiguity(num, raw) {
  const n = String(num ?? "").replace(",", ".");
  const r = String(raw ?? "");
  if (n !== "1") return n;
  if (/\b9\s*(?:ס|סמ|ס"מ|ס'מ)/u.test(r) || /קוטר[^\d]{0,30}9/u.test(r)) return "9";
  return n;
}

function stripHebrew(s) {
  return `${s ?? ""}`.replace(/[\u0590-\u05FF\u05C0-\u05C7\uFB1D-\uFB4F]/g, " ");
}

function normalizeAsciiDigits(s) {
  return `${s ?? ""}`.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48));
}

function normalizeLatinMConfusables(s) {
  return `${s ?? ""}`.replace(/\u039C/g, "M").replace(/\u041C/g, "M");
}

function hebrewMemAsLatinM(s) {
  return `${s ?? ""}`
    .replace(/מ(\s*[A-Za-z]{2}\s*\d{5})/g, "M$1")
    .replace(/מ(?=[A-Za-z]{2}\d{5})/gi, "M")
    .replace(/מ\s*(?=[A-Za-z]{2}(?:\s*\d{5}|\d{5}))/gi, "M");
}

function fixRegistrationDigitRun(run) {
  return `${run ?? ""}`
    .replace(/[OoQD]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss$]/g, "5")
    .replace(/[Gg]/g, "6")
    .replace(/[Bb]/g, "8")
    .replace(/[^0-9]/g, "");
}

function normalizeRegistrationLetterPair(two) {
  let s = `${two ?? ""}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
  s = s.replace(/0/g, "O").replace(/1/g, "I");
  if (s === "II" || s === "I1" || s === "1I") s = "H";
  if (s.length > 2) s = s.slice(0, 2);
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

function pickRegistrationFromFlat(str) {
  const toDisplay = (lettersUpper, digits) => "M" + lettersUpper + " " + digits;
  let best = "";
  const consider = (display) => {
    if (!REGISTRATION_COMPACT.test(display.replace(/\s/g, ""))) return;
    best = best ? preferRegistrationCandidate(best, display) : display;
  };
  const rx = /[Mm]([A-Za-z]{2})(\d{5})/g;
  for (const m of str.matchAll(rx)) {
    const letters = m[1].toUpperCase();
    const digits = m[2];
    consider(toDisplay(letters, digits));
  }
  if (best) return best;
  const fuzzy = /[Mm]([A-Za-z]{2})([\dA-Za-z]{4,8})/g;
  for (const m of str.matchAll(fuzzy)) {
    const letters = normalizeRegistrationLetterPair(m[1]) || m[1].toUpperCase();
    let digits = fixRegistrationDigitRun(m[2]);
    if (digits.length > 5) digits = digits.slice(0, 5);
    if (digits.length !== 5) continue;
    consider(toDisplay(letters, digits));
  }
  return best || null;
}

function formatRegistrationNumberFromRaw(raw) {
  if (raw == null || raw === "") return "";
  const rawClean = normalizeLatinMConfusables(normalizeAsciiDigits(String(raw)));
  const memFixed = hebrewMemAsLatinM(rawClean);
  const originalNorm = normalizeText(memFixed);
  const latinish = normalizeLatinMConfusables(
    stripHebrew(memFixed)
      .replace(/[|‐‑‒–—_]/g, " ")
      .replace(/[^\dA-Za-zMm\s:]/g, " "),
  );
  let flat = normalizeAsciiDigits(latinish).replace(/\s+/g, "").replace(/[^0-9A-Za-zMm]/g, "");
  flat = flat.replace(/(\d{5})/g, (d) => d.replace(/[Oo]/g, "0"));
  const toDisplay = (lettersUpper, digits) => "M" + lettersUpper + " " + digits;
  let got = pickRegistrationFromFlat(flat);
  if (got) return got;
  const spaced = originalNorm.match(/[Mm]\s*([A-Za-z])\s*([A-Za-z])\s*((?:\d\s*){5})/);
  if (spaced) {
    const letters = (spaced[1] + spaced[2]).toUpperCase();
    const digits = spaced[3].replace(/\D/g, "");
    if (digits.length === 5) {
      const compact = "M" + letters + digits;
      if (REGISTRATION_COMPACT.test(compact)) return toDisplay(letters, digits);
    }
  }
  const mi = flat.search(/[Mm]/);
  if (mi >= 0) {
    got = pickRegistrationFromFlat(flat.slice(mi));
    if (got) return got;
  }
  const looseCandidates = [
    extractRegistrationLoose(originalNorm),
    extractRegistrationLoose(latinish),
    extractRegistrationDigitAnchored(flat),
  ].filter(Boolean);
  if (looseCandidates.length) return pickBestRegistrationCandidate(looseCandidates);
  return "";
}

/** M + 2 אותיות + 5 ספרות — גם כשאין word-boundary לטיני (עברית ליד M) */
function extractRegistrationLoose(s) {
  const t = normalizeLatinMConfusables(normalizeAsciiDigits(stripHebrew(`${s ?? ""}`))).replace(
    /[^\dA-Za-zMm\s]/g,
    " ",
  );
  let best = "";
  const re = /M\s*([A-Za-z]{2})\s*(\d{5})/gi;
  for (const m of t.matchAll(re)) {
    const letters = m[1].toUpperCase();
    const digits = m[2];
    const c = "M" + letters + digits;
    if (REGISTRATION_COMPACT.test(c)) {
      const display = "M" + letters + " " + digits;
      best = best ? preferRegistrationCandidate(best, display) : display;
    }
  }
  if (best) return best;
  const flatT = t.replace(/\s+/g, "");
  for (const m of flatT.matchAll(/M([A-Za-z]{2})(\d{5})/gi)) {
    const letters = m[1].toUpperCase();
    const digits = m[2];
    const c = "M" + letters + digits;
    if (REGISTRATION_COMPACT.test(c)) {
      const display = "M" + letters + " " + digits;
      best = best ? preferRegistrationCandidate(best, display) : display;
    }
  }
  return best || null;
}

/** אחרי 5 ספרות רצופות — בודקים שממש לפניהן יש M ועוד 2 אותיות */
function extractRegistrationDigitAnchored(flat) {
  const f = flat.replace(/\s+/g, "");
  const re2 = /\d{5}/g;
  let dm;
  while ((dm = re2.exec(f)) !== null) {
    const start = dm.index;
    const digits = dm[0];
    const left = f.slice(0, start);
    const lm = left.match(/M([A-Za-z]{2})$/i);
    if (lm) {
      const letters = lm[1].toUpperCase();
      const c = "M" + letters + digits;
      if (REGISTRATION_COMPACT.test(c)) return "M" + letters + " " + digits;
    }
  }
  return null;
}

function registrationFieldIsValid(v) {
  const t = fieldInputToStored(v);
  if (!t) return true;
  return REGISTRATION_DISPLAY.test(compactOkRegistration(t) ?? "");
}

function updateRegistrationFieldValidity() {
  const el = $("cf_registration_number");
  if (!el) return;
  const v = fieldInputToStored(el.value);
  if (!v) {
    el.classList.remove("input--invalid");
    return;
  }
  el.classList.toggle("input--invalid", !registrationFieldIsValid(v));
}

function isEffectivelyEmpty(value) {
  const t = normalizeText(value)
    .replace(/[\s:.\-|–—\u2013\u2014\u2011,;'"׳״]/g, "")
    .replace(/[־׀]/g, "");
  return t.length === 0;
}

const EMPTY_FIELD_DISPLAY = "-";

function fieldInputToStored(value) {
  const t = String(value ?? "").trim();
  if (!t || t === EMPTY_FIELD_DISPLAY) return "";
  return t;
}

function storedFieldToDisplay(value) {
  const t = String(value ?? "").trim();
  return t && !isEffectivelyEmpty(t) ? t : EMPTY_FIELD_DISPLAY;
}

function fieldsForOutput(fields) {
  const o = {};
  for (const id of CARD_FIELD_IDS) {
    const v = String(fields[id] ?? "").trim();
    o[id] = v && !isEffectivelyEmpty(v) ? v : EMPTY_FIELD_DISPLAY;
  }
  return o;
}

function bindEmptyFieldDisplayBehavior(ctl) {
  ctl.addEventListener("focus", () => {
    if (ctl.value.trim() === EMPTY_FIELD_DISPLAY) ctl.value = "";
  });
  ctl.addEventListener("blur", () => {
    if (!fieldInputToStored(ctl.value)) ctl.value = EMPTY_FIELD_DISPLAY;
  });
}

function labelAliases(fieldId) {
  const f = CARD_FORM_FIELDS.find((x) => x.id === fieldId);
  if (!f) return [];
  const parts = f.label.split("/").map((p) => p.trim()).filter(Boolean);
  if (fieldId === "registration_number") {
    return [...new Set([...parts, "מספר רשום", "מס רשום", "רשום"])];
  }
  if (fieldId === "object_location_museum") {
    return [...new Set([...parts, "מקום החפץ במוזיאון", "מקום החפץ במוזאון"])];
  }
  if (fieldId === "location") {
    return [...new Set([...parts, "מקום"])];
  }
  if (fieldId === "collection_number") {
    return [...new Set([...parts, "מספר קבלה", "מס קבלה", "קבלה"])];
  }
  if (fieldId === "item_number") {
    return [...new Set([...parts, "מספר ישן", "מס ישן", "מסיישן", "ישן"])];
  }
  if (fieldId === "description") {
    return [...new Set([...parts, "תיאור החפץ", "תיאור פריט"])];
  }
  if (fieldId === "notes") {
    return [...new Set([...parts, "הערה", "הערות כתב יד"])];
  }
  return parts;
}

function isLabelOnlyValue(fieldId, value) {
  const t = normalizeText(value);
  if (isEffectivelyEmpty(t)) return true;
  const fold = (s) =>
    s
      .replace(/[\s:.\-|–—,;'"׳״]/g, "")
      .replace(/און/g, "אום")
      .toLowerCase();
  const vf = fold(t);
  for (const a of labelAliases(fieldId)) {
    if (fold(a) === vf) return true;
  }
  return false;
}

function collectionNumberLooksPlausible(value) {
  const t = normalizeText(value);
  if (!t) return false;
  if (looksLikeRegistrationNumber(t)) return false;
  if (isLabelOnlyValue("collection_number", t)) return false;
  if (!/\d/.test(t)) return false;
  const he = (t.match(/[\u0590-\u05FF]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (he >= 8 && digits <= 2) return false;
  return true;
}

function stripItemNumberOcrGunk(v) {
  let t = normalizeText(v);
  const patterns = [
    /^[:\s.\-|–∙•]*(?:-\s*)?(?:מספר|מס)['׳״]?\s*מסיישן\s*[:\-–.]?\s*/i,
    /^[:\s.\-|–∙•]*(?:-\s*)?מסיישן\s*[:\-–.]?\s*/i,
    /^[:\s.\-|–∙•]*(?:-\s*)?(?:מספר|מס)['׳״]?\s*ישן\s*[:\-–.]?\s*/i,
    /^[:\s.\-|–∙•]*(?:-\s*)?מס\s*יישן\s*[:\-–.]?\s*/i,
  ];
  for (const p of patterns) t = t.replace(p, "").trim();
  t = t.replace(/^['׳״:\s.\-|–]+/, "").trim();
  t = t.replace(/^-+/, "").trim();
  if (/[\u0590-\u05FF]/.test(t) && /\d/.test(t)) t = t.replace(/^[^\d]*(?=\d)/u, "").trim();
  return t;
}

function escapeRegExp(s) {
  return `${s ?? ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripKnownLabelPrefix(fieldId, value) {
  let v = normalizeText(value);
  const strips = {
    registration_number: /^[:\s.\-|–]*(?:מספר|מס)['׳״]?\s*רשו?ם[:\s.\-|–]*/i,
    collection_number: /^[:\s.\-|–]*(?:מספר|מס)['׳״]?\s*קבלה[:\s.\-|–]*/i,
    item_number: /^[:\s.\-|–]*(?:מספר|מס)['׳״]?\s*ישן[:\s.\-|–]*/i,
    material: /^[:\s.\-|–]*חומר[:\s.\-|–]*/i,
    typology: /^[:\s.\-|–]*(?:טפוס|טיפוס)[:\s.\-|–]*/i,
    period: /^[:\s.\-|–]*תקופה[:\s.\-|–]*/i,
    height: /^[:\s.\-|–]*גובה[:\s.\-|–]*/i,
    width: /^[:\s.\-|–]*רוחב[:\s.\-|–]*/i,
    diameter: /^[:\s.\-|–]*קוטר[:\s.\-|–]*/i,
    object_location_museum: /^[:\s.\-|–]*מקום\s*החפץ\s*במוזי?או?מ?[:\s.\-|–]*/i,
    location: /^[:\s.\-|–]*(?:מוצא|מקום)[:\s.\-|–]+/i,
    description: /^[:\s.\-|–]*תיאור[:\s.\-|–]*/i,
    notes: /^[:\s.\-|–]*הערות?[:\s.\-|–]*/i,
  };
  const rx = strips[fieldId];
  if (rx) v = v.replace(rx, "").trim();
  if (fieldId === "item_number") v = stripItemNumberOcrGunk(v);
  return v;
}

const DIM_UNIT_FRAGMENT =
  "סנטימטר|סמ['׳״]?|ס['׳״]?מ|ס״מ|ס\"מ|ממ['׳״]?|מ['׳״]?מ|מ״מ|מ\"מ|מילימטר|cm\\.?|mm\\.?|in\\.?|inch|(?<![א-ת])m(?![א-תa-z])|סמ|ממ";
const DEFAULT_DIM_UNIT = "סמ'";

function isBareDimensionNumber(num) {
  return /^\d+(\.\d+)?$/.test(String(num ?? "").trim());
}

function normalizeDimUnit(u) {
  const t = `${u ?? ""}`.trim();
  if (!t) return "";
  if (/^סנטימטר$/i.test(t) || /סמ['׳״]|ס'מ|ס״מ|ס"מ|^סמ$/i.test(t) || /^ס(?=[״"׳']מ)/i.test(t)) return "סמ'";
  if (/^מילימטר$/i.test(t) || /ממ['׳״]|מ'מ|מ״מ|מ"מ|^ממ$/i.test(t) || /^מ(?=[״"׳']מ)/i.test(t)) return "ממ'";
  if (/^cm\b/i.test(t)) return "סמ'";
  if (/^mm\b/i.test(t)) return "ממ'";
  if (/^m$/i.test(t)) return "m";
  if (/^in\.?$|^inch$/i.test(t)) return "inch";
  return t;
}

function sanitizeDimensionValue(raw) {
  const s0 = String(raw ?? "")
    .replace(/גובה|רוחב|קוטר|Height|Width|Diameter/gi, " ")
    .trim();
  if (!/\d/.test(s0)) return "";
  const pair = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:(${DIM_UNIT_FRAGMENT}))?`,
    "iu",
  ).exec(s0);
  if (pair) {
    const u = normalizeDimUnit(pair[3] || "");
    const a = pair[1].replace(",", ".");
    const b = pair[2].replace(",", ".");
    const unit = u || DEFAULT_DIM_UNIT;
    return `${a}×${b} ${unit}`.trim();
  }
  const rev = new RegExp(`^(${DIM_UNIT_FRAGMENT})\\s*(\\d+(?:[.,]\\d+)?)`, "iu").exec(s0);
  if (rev) {
    const num = rev[2].replace(",", ".");
    const u = normalizeDimUnit(rev[1]);
    if (u && isBareDimensionNumber(num)) return `${num} ${u}`.trim();
  }
  const m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:(${DIM_UNIT_FRAGMENT}))?`, "iu").exec(s0);
  if (!m) return "";
  let num = m[1].replace(",", ".");
  let unitRaw = (m[2] || "").trim();
  if (!unitRaw) {
    const after = s0.slice(m.index + m[0].length).trim();
    const loose = new RegExp(`^(${DIM_UNIT_FRAGMENT})(?=\\s|$)`, "iu").exec(after);
    if (loose) unitRaw = loose[1].trim();
  }
  const u = normalizeDimUnit(unitRaw);
  if (u) return `${num} ${u}`.trim();
  if (isBareDimensionNumber(num)) return `${num} ${DEFAULT_DIM_UNIT}`;
  return num;
}

/** עריכה ידנית: שומר עברית/אנגלית ורישיות (א/א) ללא סינון OCR אגרסיבי */
function finalizeManualFieldValue(fieldId, raw) {
  raw = stripFrameArtifacts(String(raw ?? ""));
  if (fieldId === "registration_number") {
    return canonicalRegistration(raw, "") || "";
  }
  if (fieldId === "collection_number") return finalizeCollectionNumber(raw);
  if (fieldId === "item_number") return finalizeItemNumber(raw);
  if (fieldId === "period") return finalizePeriodValue(raw);
  if (fieldId === "typology") return finalizeTypology(raw);
  if (fieldId === "description" || fieldId === "notes") return finalizeLongTextField(fieldId, raw);
  if (fieldId === "location" || fieldId === "object_location_museum") {
    return finalizeLocationField(fieldId, raw);
  }
  if (fieldId === "material") {
    let v = normalizeMaterialText(stripKnownLabelPrefix("material", raw));
    if (isLabelOnlyValue("material", v)) return "";
    return polishFieldSpacing("material", applyHebrewFieldCorrection("material", v));
  }
  if (["height", "width", "diameter"].includes(fieldId)) {
    let v = stripKnownLabelPrefix(fieldId, normalizeText(raw));
    if (!v || isLabelOnlyValue(fieldId, v)) return "";
    let out = sanitizeDimensionValue(v) || v;
    const m = out.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) {
      const fixed = fixDimensionDigitAmbiguity(m[1], raw);
      if (fixed !== m[1]) out = `${fixed} ${m[2]}`;
    }
    return polishFieldSpacing(fieldId, out);
  }
  let v = stripKnownLabelPrefix(fieldId, normalizeText(raw));
  if (isLabelOnlyValue(fieldId, v)) return "";
  if (isEffectivelyEmpty(v)) return "";
  return polishFieldSpacing(fieldId, applyHebrewFieldCorrection(fieldId, v));
}

function finalizeOcrFieldValue(fieldId, raw, fullPageText = "") {
  raw = stripFrameArtifacts(String(raw ?? ""));
  fullPageText = stripFrameArtifacts(String(fullPageText ?? ""));

  if (fieldId === "registration_number") {
    raw = hebrewMemAsLatinM(raw);
    fullPageText = hebrewMemAsLatinM(fullPageText);
    raw = normalizeLatinMConfusables(normalizeAsciiDigits(raw));
    fullPageText = normalizeLatinMConfusables(normalizeAsciiDigits(fullPageText));
    const v =
      canonicalRegistration(raw, fullPageText) || rescueRegistrationField(raw, fullPageText);
    const rawNorm = stripKnownLabelPrefix(fieldId, raw);
    if (!v && (isLabelOnlyValue(fieldId, rawNorm) || isEffectivelyEmpty(rawNorm))) return "";
    return v;
  }

  let v = normalizeText(String(raw ?? ""));
  v = stripKnownLabelPrefix(fieldId, v);
  if (isLabelOnlyValue(fieldId, v)) return "";
  if (fieldId === "collection_number") return finalizeCollectionNumber(v || raw);
  if (fieldId === "item_number") return finalizeItemNumber(v || raw);
  if (fieldId === "period") return finalizePeriodValue(v || raw);
  if (fieldId === "typology") return finalizeTypology(v || raw);
  if (fieldId === "description" || fieldId === "notes") return finalizeLongTextField(fieldId, v || raw);
  if (fieldId === "material") {
    v = normalizeMaterialText(stripKnownLabelPrefix(fieldId, v));
    if (isLabelOnlyValue(fieldId, v)) return "";
    return polishFieldSpacing(fieldId, applyHebrewFieldCorrection(fieldId, normalizeText(v)));
  }
  if (fieldId === "object_location_museum" || fieldId === "location") {
    return finalizeLocationField(fieldId, v || raw);
  }
  if (["height", "width", "diameter"].includes(fieldId)) {
    const rawIn = v || raw;
    v = sanitizeDimensionValue(rawIn) || v;
    const m = v.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) {
      const fixed = fixDimensionDigitAmbiguity(m[1], rawIn);
      if (fixed !== m[1]) v = `${fixed} ${m[2]}`;
    }
    if (isEffectivelyEmpty(v)) return "";
    return polishFieldSpacing(fieldId, v);
  }
  v = stripFrameArtifacts(v);
  if (isEffectivelyEmpty(v)) return "";
  return polishFieldSpacing(fieldId, applyHebrewFieldCorrection(fieldId, v));
}

function parseWholeImageFields(rawText) {
  const text = normalizeOcrQuotes(stripFrameArtifacts(rawText));
  const out = Object.fromEntries(CARD_FIELD_IDS.map((id) => [id, ""]));
  for (const [id, patterns] of WHOLE_IMAGE_PATTERNS_ORDERED) {
    const v = firstRegexCapture(text, patterns);
    if (v) out[id] = v;
  }
  for (const id of CARD_FIELD_IDS) {
    out[id] = finalizeOcrFieldValue(id, out[id], text.replace(/\n/g, " "));
  }
  return out;
}

async function setTesseractParamsForRoiField(worker, fieldId) {
  if (fieldId === "registration_number") {
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "6",
      tessedit_char_whitelist: " Mm0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    });
  } else if (HEBREW_PARAGRAPH_FIELD_IDS.has(fieldId)) {
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "4",
      user_defined_dpi: "300",
      tessedit_char_whitelist: "",
    });
  } else {
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "6",
      tessedit_char_whitelist: "",
    });
  }
}

async function resetTesseractParamsAfterRoiLoop(worker) {
  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist: "",
  });
}

function createCardFieldPair(f) {
  const pair = document.createElement("div");
  pair.className =
    "fieldPair" +
    (f.id === "notes" ? " fieldPair--notes" : "") +
    (f.id === "description" ? " fieldPair--description" : "") +
    (f.id === "object_location_museum" ? " fieldPair--object_location_museum" : "") +
    (f.id === "location" ? " fieldPair--location" : "");
  const lab = document.createElement("label");
  lab.htmlFor = `cf_${f.id}`;
  lab.textContent = f.label;
  const useTallTextarea = TALL_TEXTAREA_FIELD_IDS.has(f.id);
  const ctl =
    f.id === "registration_number"
      ? document.createElement("input")
      : useTallTextarea
        ? document.createElement("textarea")
        : document.createElement("input");
  ctl.className = "cardFieldControl";
  if (f.id === "registration_number") {
    ctl.classList.add("cardFieldControl--single");
  } else if (f.id === "notes") {
    ctl.classList.add("cardFieldControl--textarea", "cardFieldControl--textarea-notes");
  } else if (useTallTextarea) {
    ctl.classList.add("cardFieldControl--textarea", "cardFieldControl--textarea-tall");
  } else {
    ctl.classList.add("cardFieldControl--single");
  }
  ctl.id = `cf_${f.id}`;
  ctl.autocomplete = "off";
  ctl.spellcheck = false;
  ctl.setAttribute("dir", "auto");
  ctl.setAttribute("lang", "he");
  ctl.title = "עריכה ידנית: עברית ואנגלית, אותיות גדולות וקטנות";
  if (f.id === "registration_number") {
    ctl.type = "text";
    ctl.placeholder = "";
    ctl.maxLength = 16;
    ctl.title =
      "מס' רשום: M + 2 אותיות + רווח + 5 ספרות (למשל MHP 72958). ניתן להקליד ידנית בעברית/אנגלית.";
    ctl.addEventListener("input", () => {
      updateRegistrationFieldValidity();
      syncOutputFromManualEdits();
    });
    ctl.addEventListener("focus", () => {
      if (ctl.value.trim() === EMPTY_FIELD_DISPLAY) ctl.value = "";
    });
    ctl.addEventListener("blur", () => {
      const cur = fieldInputToStored(ctl.value);
      if (!cur) {
        ctl.value = EMPTY_FIELD_DISPLAY;
        updateRegistrationFieldValidity();
        return;
      }
      const canonical = canonicalRegistration(cur, "");
      ctl.value = storedFieldToDisplay(canonical || "");
      updateRegistrationFieldValidity();
      syncOutputFromManualEdits();
    });
  } else if (f.id === "notes") {
    ctl.placeholder = "";
    ctl.rows = 5;
    ctl.wrap = "soft";
  } else if (f.id === "description") {
    ctl.classList.add("cardFieldControl--textarea", "cardFieldControl--textarea-description");
    ctl.placeholder = "";
    ctl.rows = 5;
    ctl.wrap = "soft";
  } else if (f.id === "object_location_museum") {
    ctl.type = "text";
    ctl.classList.add("cardFieldControl--single");
    ctl.placeholder = "";
  } else if (useTallTextarea) {
    ctl.placeholder = "";
    ctl.rows = 3;
    ctl.wrap = "soft";
  } else {
    ctl.type = "text";
    ctl.placeholder = "";
  }
  if (f.id !== "registration_number") bindEmptyFieldDisplayBehavior(ctl);
  bindCardFieldManualSync(ctl);
  pair.appendChild(lab);
  pair.appendChild(ctl);
  return pair;
}

function buildCardFieldsGrid() {
  const grid = $("cardFieldsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const f of CARD_FORM_FIELDS) {
    if (f.id === "height") {
      const stack = document.createElement("div");
      stack.className = "fieldStack fieldStack--dimsMetrics";
      for (const id of DIM_METRICS_IDS) {
        const def = CARD_FORM_FIELDS.find((x) => x.id === id);
        if (def) stack.appendChild(createCardFieldPair(def));
      }
      grid.appendChild(stack);
      continue;
    }
    if (DIM_METRICS_ID_SET.has(f.id)) continue;
    if (f.id === "object_location_museum") {
      const stack = document.createElement("div");
      stack.className = "fieldStack fieldStack--museumDesc";
      for (const id of MUSEUM_DESC_STACK_IDS) {
        const def = CARD_FORM_FIELDS.find((x) => x.id === id);
        if (def) stack.appendChild(createCardFieldPair(def));
      }
      grid.appendChild(stack);
      continue;
    }
    if (MUSEUM_DESC_STACK_ID_SET.has(f.id)) continue;
    grid.appendChild(createCardFieldPair(f));
  }
}

function readCardFieldsFromForm() {
  const o = {};
  for (const id of CARD_FIELD_IDS) {
    const el = $(`cf_${id}`);
    const raw = el ? fieldInputToStored(el.value) : "";
    o[id] = raw ? finalizeManualFieldValue(id, raw) : "";
  }
  return o;
}

let syncOutputTimer = null;

function syncOutputFromManualEditsNow() {
  if (!lastResult) return;
  const mode = lastResult.meta?.mode;
  if (mode !== "template" && mode !== "whole_image") return;
  const fields = readCardFieldsFromForm();
  lastResult = { ...lastResult, fields };
  output.value = JSON.stringify({ ...lastResult, fields: fieldsForOutput(fields) }, null, 2);
  setDownloadsEnabled(true);
}

function syncOutputFromManualEdits() {
  if (syncOutputTimer) clearTimeout(syncOutputTimer);
  syncOutputTimer = setTimeout(syncOutputFromManualEditsNow, 300);
}

function bindCardFieldManualSync(ctl) {
  ctl.addEventListener("input", syncOutputFromManualEdits);
  ctl.addEventListener("blur", syncOutputFromManualEditsNow);
}

function applyFieldsToCardForm(fields) {
  const f = fields ?? {};
  for (const id of CARD_FIELD_IDS) {
    const el = $(`cf_${id}`);
    if (!el) continue;
    const raw = String(f[id] ?? "").trim();
    const stored = raw ? finalizeManualFieldValue(id, raw) : "";
    el.value = storedFieldToDisplay(stored);
  }
  updateRegistrationFieldValidity();
}

function mergeRegistrationFromResults(results) {
  let best = "";
  let bestScore = -1;
  const blobs = [];
  for (const r of results.filter((x) => x.field === "registration_number")) {
    for (const part of [r.text, r.rawOcr, ...(r.rawAttempts ?? [])]) {
      const t = `${part ?? ""}`.trim();
      if (t) blobs.push(t);
    }
  }
  const tryBlob = (blob) => {
    const v = rescueRegistrationField(blob, "");
    if (!v) return;
    const score = registrationMergeScore(v);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  };
  for (const b of blobs) tryBlob(b);
  if (blobs.length > 1) tryBlob(blobs.join("\n"));
  return best;
}

function mergeTemplateOcrResults(results) {
  const mergedFields = Object.fromEntries(CARD_FIELD_IDS.map((id) => [id, ""]));
  for (const r of results) {
    if (!CARD_FIELD_IDS.includes(r.field)) continue;
    mergedFields[r.field] = mergeCardFieldValue(r.field, mergedFields[r.field], r.text);
  }
  for (const id of CARD_FIELD_IDS) {
    if (mergedFields[id] && !isEffectivelyEmpty(mergedFields[id])) continue;
    for (const r of results.filter((x) => x.field === id)) {
      const v = finalizeOcrFieldValue(id, r.rawOcr ?? "", "");
      if (v) {
        mergedFields[id] = v;
        break;
      }
    }
  }
  const reg = mergeRegistrationFromResults(results);
  if (reg) mergedFields.registration_number = reg;
  return mergedFields;
}

function expandNormRect(rect, padRatio = 0.12) {
  const p = Math.max(0, padRatio);
  const x = Math.max(0, rect.x - rect.w * p);
  const y = Math.max(0, rect.y - rect.h * p);
  const w = Math.min(1 - x, rect.w * (1 + 2 * p));
  const h = Math.min(1 - y, rect.h * (1 + 2 * p));
  return { x, y, w, h };
}

function registrationFallbackNormRect() {
  const regs = regions.filter(
    (r) => r.field === "registration_number" && r.rect.w >= MIN_REGION_SIZE && r.rect.h >= MIN_REGION_SIZE,
  );
  if (regs.length === 0) return { x: 0.32, y: 0.2, w: 0.36, h: 0.1 };
  const best = regs.reduce((a, b) => (a.rect.w * a.rect.h >= b.rect.w * b.rect.h ? a : b));
  return expandNormRect(best.rect, 0.18);
}

async function ocrRegistrationRegion(worker, roi, pre) {
  const rawAttempts = [];
  const scoreResult = (finalized, raw, confidence) => ({
    finalized,
    raw,
    confidence,
    score: finalized ? registrationMergeScore(finalized) : 0,
  });

  let best = scoreResult("", "", 0);

  const runAttempt = async (canvas, setup) => {
    if (setup) await setup();
    const { data } = await worker.recognize(canvas);
    const raw = normalizeText(stripFrameArtifacts(data.text));
    rawAttempts.push(raw);
    const finalized = finalizeOcrFieldValue("registration_number", raw, raw);
    const cand = scoreResult(finalized, raw, data.confidence);
    if (cand.score > best.score || (!best.finalized && cand.finalized)) best = cand;
    return cand.finalized;
  };

  await setTesseractParamsForRoiField(worker, "registration_number");
  if (await runAttempt(roi, null)) return { ...best, rawAttempts };

  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist: "",
  });
  if (await runAttempt(roi, null)) return { ...best, rawAttempts };

  await setTesseractParamsForRoiField(worker, "registration_number");
  if (await runAttempt(pre, null)) return { ...best, rawAttempts };

  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist: "",
  });
  await runAttempt(pre, null);
  return { ...best, rawAttempts };
}

async function ocrHebrewParagraphRegion(worker, fieldId, roi, pre) {
  const rawAttempts = [];
  const pickBetter = (a, b) => {
    if (!b.finalized && a.finalized) return a;
    if (b.finalized && !a.finalized) return b;
    if (a.finalized && b.finalized) return b.confidence >= a.confidence ? b : a;
    return b.confidence >= a.confidence ? b : a;
  };

  const runAttempt = async (canvas, setup) => {
    if (setup) await setup();
    const { data } = await worker.recognize(canvas);
    const raw = normalizeLongText(stripFrameArtifacts(data.text));
    rawAttempts.push(raw);
    const finalized = finalizeOcrFieldValue(fieldId, raw, "");
    return { raw, finalized, confidence: data.confidence ?? 0 };
  };

  let best = await runAttempt(roi, () => setTesseractParamsForRoiField(worker, fieldId));
  const preTry = await runAttempt(pre, () => setTesseractParamsForRoiField(worker, fieldId));
  best = pickBetter(best, preTry);

  if (!best.finalized) {
    const fallback = await runAttempt(pre, async () => {
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: "6",
        user_defined_dpi: "300",
        tessedit_char_whitelist: "",
      });
    });
    best = pickBetter(best, fallback);
  }

  return { ...best, rawAttempts };
}

function clearCardFieldsForm() {
  applyFieldsToCardForm(Object.fromEntries(CARD_FIELD_IDS.map((id) => [id, ""])));
}

async function loadImage(file) {
  imageBitmap = await createImageBitmap(file);
  drawPreview();
  runBtn.disabled = false;
  output.value = "";
  lastResult = null;
  setDownloadsEnabled(false);
  clearCardFieldsForm();
  loadTemplateFromStorage();
  addRegionBtn.disabled = false;
  modeSelect.disabled = false;
  renderRegionsUI();
  drawOverlay();
  updateRegistrationFieldValidity();
}

function drawPreview() {
  if (!imageBitmap) return;
  const maxW = 2000;
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

const VALID_FIELD_IDS = new Set(FIELD_OPTIONS.map((f) => f.id));

function normalizeRegionField(fieldId) {
  if (VALID_FIELD_IDS.has(fieldId)) return fieldId;
  const mapped = LEGACY_FIELD_MAP[fieldId];
  if (mapped && VALID_FIELD_IDS.has(mapped)) return mapped;
  return CARD_FORM_FIELDS[0].id;
}

function sanitizeRegionsFields() {
  let dirty = false;
  const kept = regions.filter((r) => r.rect.w >= MIN_REGION_SIZE && r.rect.h >= MIN_REGION_SIZE);
  if (kept.length !== regions.length) {
    regions = kept;
    dirty = true;
    if (activeRegionId && !regions.some((r) => r.id === activeRegionId)) {
      activeRegionId = regions[0]?.id ?? null;
    }
  }
  for (const r of regions) {
    const n = normalizeRegionField(r.field);
    if (n !== r.field) {
      r.field = n;
      dirty = true;
    }
  }
  if (dirty) saveTemplateToStorage();
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
    sanitizeRegionsFields();
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

function setActiveRegion(id) {
  activeRegionId = id;
  renderRegionsUI();
  drawOverlay();
}

function deleteRegionById(id) {
  if (!id) return;
  regions = regions.filter((r) => r.id !== id);
  if (activeRegionId === id) activeRegionId = regions[0]?.id ?? null;
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
}

function fieldLabel(fieldId) {
  return FIELD_OPTIONS.find((f) => f.id === fieldId)?.label ?? fieldId;
}

function fillFieldSelect(selectEl, value) {
  selectEl.innerHTML = FIELD_OPTION_TAGS;
  if (value && VALID_FIELD_IDS.has(value)) selectEl.value = value;
}

function renderFieldSelect() {
  if (!fieldSelect) return;
  const active = getActiveRegion();
  const fid = active?.field && VALID_FIELD_IDS.has(active.field) ? active.field : FIELD_OPTIONS[0].id;
  fillFieldSelect(fieldSelect, fid);
  fieldSelect.disabled = !imageBitmap;
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

    const fieldPick = document.createElement("select");
    fieldPick.className = "regionRow__fieldSelect";
    fieldPick.title = "עדכון ידני: איזה שדה האזור מייצג";
    const fid = r.field && VALID_FIELD_IDS.has(r.field) ? r.field : FIELD_OPTIONS[0].id;
    fillFieldSelect(fieldPick, fid);
    fieldPick.addEventListener("change", () => {
      r.field = normalizeRegionField(fieldPick.value);
      saveTemplateToStorage();
      renderRegionsUI();
      drawOverlay();
    });

    const meta = document.createElement("div");
    meta.className = "regionRow__meta";
    meta.textContent = `x:${r.rect.x.toFixed(3)} y:${r.rect.y.toFixed(3)} w:${r.rect.w.toFixed(3)} h:${r.rect.h.toFixed(3)}`;

    left.appendChild(fieldPick);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "regionRow__actions";

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "regionRow__btn";
    selectBtn.textContent = "בחר";
    selectBtn.addEventListener("click", () => setActiveRegion(r.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "regionRow__btn regionRow__btn--danger";
    deleteBtn.textContent = "מחק";
    deleteBtn.addEventListener("click", () => deleteRegionById(r.id));

    actions.appendChild(selectBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(left);
    row.appendChild(actions);
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
    octx.strokeStyle = isActive ? "rgba(255, 214, 10, 0.98)" : "rgba(255, 214, 10, 0.72)";
    octx.fillStyle = isActive ? "rgba(255, 214, 10, 0.14)" : "rgba(255, 214, 10, 0.07)";
    octx.fillRect(px.x, px.y, px.w, px.h);
    octx.strokeRect(px.x, px.y, px.w, px.h);

    // label
    const label = fieldLabel(r.field);
    octx.font = "12px ui-sans-serif, system-ui, Segoe UI, Arial";
    const pad = 6;
    const tw = octx.measureText(label).width;
    const boxW = Math.min(px.w, tw + pad * 2);
    const boxH = 18;
    octx.fillStyle = isActive ? "rgba(255, 214, 10, 0.95)" : "rgba(0,0,0,.55)";
    octx.fillRect(px.x, Math.max(0, px.y - boxH), boxW, boxH);
    octx.fillStyle = isActive ? "#1a1400" : "rgba(255,255,255,.9)";
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
  octx.fillStyle = "rgba(255, 214, 10, 0.95)";
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
    x: clamp01(px / (overlay.width || 1)),
    y: clamp01(py / (overlay.height || 1)),
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
  const rw = rect.width || 1;
  const rh = rect.height || 1;
  const x = ((e.clientX - rect.left) / rw) * overlay.width;
  const y = ((e.clientY - rect.top) / rh) * overlay.height;
  return { x, y };
}

let drag = null; // { type: 'create'|'move'|'resize', handle?, startPx, startRectNorm, regionId }
let overlayRaf = 0;

function scheduleDrawOverlay() {
  if (overlayRaf) return;
  overlayRaf = requestAnimationFrame(() => {
    overlayRaf = 0;
    drawOverlay();
  });
}

/** שדה ל-ROI חדש: Selected field, או שדה כרטיס ראשון שעדיין בלי מלבן — תמיד ROI נוסף */
function fieldIdForNewRegion() {
  if (fieldSelect?.value && VALID_FIELD_IDS.has(fieldSelect.value)) return fieldSelect.value;
  const missingCard = CARD_FIELD_IDS.find((id) => !regions.some((r) => r.field === id));
  if (missingCard) return missingCard;
  return CARD_FIELD_IDS[0];
}

function beginCreateRegion() {
  const field = fieldIdForNewRegion();
  const id = uid();
  const r = { id, field, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } };
  regions = [r, ...regions];
  setActiveRegion(id);
  saveTemplateToStorage();
}

function deleteActiveRegion() {
  if (!activeRegionId) return;
  deleteRegionById(activeRegionId);
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
  sanitizeRegionsFields();
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

  if (mode === "contrast") {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const boosted = Math.max(0, Math.min(255, (lum - 128) * 1.35 + 128));
      d[i] = d[i + 1] = d[i + 2] = Math.round(boosted);
    }
  }

  // simple luminance
  if (mode !== "contrast") {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      d[i] = lum;
      d[i + 1] = lum;
      d[i + 2] = lum;
    }
  }

  if (mode === "gray") {
    cctx.putImageData(img, 0, 0);
    return c;
  }

  // auto / bw / contrast threshold
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  const mean = sum / (d.length / 4);
  const threshold =
    mode === "bw" ? 175 : mode === "contrast" ? Math.min(190, Math.max(130, mean + 10)) : Math.min(195, Math.max(140, mean + 15));

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

  await loadHebrewOcrLexicon();
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

    const fields = parseWholeImageFields(data.text);
    const extracted = {
      meta: {
        mode: "whole_image",
        lang,
        scale,
        createdAt: new Date().toISOString(),
      },
      text: normalizeText(stripFrameArtifacts(data.text)),
      confidence: data.confidence,
      fields,
    };

    lastResult = extracted;
    applyFieldsToCardForm(fields);
    output.value = JSON.stringify({ ...extracted, fields: fieldsForOutput(fields) }, null, 2);
    setDownloadsEnabled(true);
  } finally {
    await worker.terminate();
    setBusy(false);
  }
}

async function runOcrTemplate() {
  if (!imageBitmap) return;
  await loadHebrewOcrLexicon();
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

      let raw = "";
      let finalized = "";
      let confidence = 0;
      let rawAttempts = [];
      let ocrEngine = "tesseract";

      if (r.field === "registration_number") {
        const reg = await ocrRegistrationRegion(worker, roi, pre);
        raw = reg.raw;
        finalized = reg.finalized;
        confidence = reg.confidence;
        rawAttempts = reg.rawAttempts;
      } else if (r.field === "notes" && notesCloudOcrEnabled()) {
        output.value = `Running OCR (template)...\nField ${idx}/${ocrTargets.length}: ${fieldLabel(r.field)} (Google Vision — notes ROI only)\n`;
        try {
          const cloud = await ocrNotesViaGoogleCloud(roi);
          raw = cloud.raw;
          finalized = cloud.finalized;
          confidence = cloud.confidence;
          rawAttempts = cloud.rawAttempts;
          ocrEngine = cloud.engine || "google_vision";
        } catch (err) {
          output.value += `Google Vision failed: ${err?.message ?? err}\nFalling back to local Tesseract.\n`;
          const para = await ocrHebrewParagraphRegion(worker, r.field, roi, pre);
          raw = para.raw;
          finalized = para.finalized;
          confidence = para.confidence;
          rawAttempts = para.rawAttempts;
          ocrEngine = "tesseract";
        }
      } else if (HEBREW_PARAGRAPH_FIELD_IDS.has(r.field)) {
        const para = await ocrHebrewParagraphRegion(worker, r.field, roi, pre);
        raw = para.raw;
        finalized = para.finalized;
        confidence = para.confidence;
        rawAttempts = para.rawAttempts;
      } else {
        await setTesseractParamsForRoiField(worker, r.field);
        const { data } = await worker.recognize(pre);
        raw = normalizeText(stripFrameArtifacts(data.text));
        finalized = finalizeOcrFieldValue(r.field, raw, "");
        confidence = data.confidence;
      }

      results.push({
        field: r.field,
        label: fieldLabel(r.field),
        text: finalized,
        rawOcr: raw,
        rawAttempts,
        confidence,
        rect: r.rect,
        engine: ocrEngine,
      });
    }

    await resetTesseractParamsAfterRoiLoop(worker);

    let mergedFields = mergeTemplateOcrResults(results);

    if (!mergedFields.registration_number) {
      const strip = regionToCanvas(registrationFallbackNormRect(), scale);
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: "6",
        tessedit_char_whitelist: "",
      });
      const { data: stripData } = await worker.recognize(strip);
      const stripRaw = normalizeText(stripFrameArtifacts(stripData.text));
      const regOnly = results
        .filter((x) => x.field === "registration_number")
        .flatMap((x) => [x.rawOcr, ...(x.rawAttempts ?? [])])
        .filter(Boolean)
        .join("\n");
      const rescued = rescueRegistrationField(stripRaw, regOnly);
      if (rescued) mergedFields = { ...mergedFields, registration_number: rescued };
      await resetTesseractParamsAfterRoiLoop(worker);
    }

    const extracted = {
      meta: {
        mode: "template",
        lang,
        scale,
        preprocess: preprocessSelect.value,
        notesOcr: notesCloudOcrEnabled() ? "google_vision" : "tesseract",
        notesOcrApi: notesCloudOcrEnabled() ? notesOcrApiBase() : null,
        createdAt: new Date().toISOString(),
      },
      fields: mergedFields,
      fieldDetails: results,
    };

    lastResult = extracted;
    applyFieldsToCardForm(mergedFields);
    output.value = JSON.stringify({ ...extracted, fields: fieldsForOutput(mergedFields) }, null, 2);
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

function notesCloudOcrEnabled() {
  return Boolean(notesCloudOcrCheckbox?.checked);
}

function notesOcrApiBase() {
  const raw = `${notesOcrApiInput?.value ?? DEFAULT_NOTES_OCR_API}`.trim();
  return (raw || DEFAULT_NOTES_OCR_API).replace(/\/$/, "");
}

function canvasToPngDataUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode notes ROI as PNG"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(`${reader.result ?? ""}`);
        reader.onerror = () => reject(reader.error || new Error("Failed to read PNG blob"));
        reader.readAsDataURL(blob);
      },
      "image/png",
    );
  });
}

async function ocrNotesViaGoogleCloud(roiCanvas) {
  const imageBase64 = await canvasToPngDataUrl(roiCanvas);
  const res = await fetch(`${notesOcrApiBase()}/api/ocr/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Notes OCR API HTTP ${res.status}`);
  }
  const raw = normalizeLongText(stripFrameArtifacts(data.text || ""));
  const finalized = finalizeOcrFieldValue("notes", raw, "");
  return {
    raw,
    finalized,
    confidence: null,
    rawAttempts: [raw],
    engine: data.source || "google_vision",
  };
}

function loadNotesCloudOcrPrefs() {
  try {
    const raw = localStorage.getItem(NOTES_CLOUD_OCR_STORAGE_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (notesCloudOcrCheckbox && typeof prefs.enabled === "boolean") {
      notesCloudOcrCheckbox.checked = prefs.enabled;
    }
    if (notesOcrApiInput && prefs.apiBase) {
      notesOcrApiInput.value = prefs.apiBase;
    }
  } catch {
    /* ignore */
  }
}

function saveNotesCloudOcrPrefs() {
  try {
    localStorage.setItem(
      NOTES_CLOUD_OCR_STORAGE_KEY,
      JSON.stringify({
        enabled: Boolean(notesCloudOcrCheckbox?.checked),
        apiBase: notesOcrApiBase(),
      }),
    );
  } catch {
    /* ignore */
  }
}

function bindNotesCloudOcrPrefs() {
  loadNotesCloudOcrPrefs();
  notesCloudOcrCheckbox?.addEventListener("change", saveNotesCloudOcrPrefs);
  notesOcrApiInput?.addEventListener("change", saveNotesCloudOcrPrefs);
  notesOcrApiInput?.addEventListener("blur", saveNotesCloudOcrPrefs);
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

if (fieldSelect) {
  fieldSelect.addEventListener("change", () => {
    const active = getActiveRegion();
    if (!active) return;
    active.field = fieldSelect.value;
    saveTemplateToStorage();
    renderRegionsUI();
    drawOverlay();
  });
}

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
  if (fieldSelect) fieldSelect.disabled = true;
  modeSelect.disabled = true;
  regionsList.innerHTML = "";
  clearCardFieldsForm();
  renderRegionsUI();
  updateRegistrationFieldValidity();
});

downloadJsonBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const payload =
    lastResult.meta?.mode === "template" || lastResult.meta?.mode === "whole_image"
      ? { ...lastResult, fields: fieldsForOutput(readCardFieldsFromForm()) }
      : lastResult;
  downloadText("museum-card.json", JSON.stringify(payload, null, 2), "application/json");
});

downloadCsvBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const mode = lastResult?.meta?.mode;
  if (mode === "template" || mode === "whole_image") {
    const fields = fieldsForOutput(readCardFieldsFromForm());
    const keys = CARD_FIELD_IDS;
    const headers = keys;
    const row = keys.map((k) => fields[k] ?? "");
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
    return;
  }

  // start creating a new region (if none hit)
  const field =
    fieldSelect?.value && VALID_FIELD_IDS.has(fieldSelect.value) ? fieldSelect.value : FIELD_OPTIONS[0].id;
  const id = uid();
  const p = pxToNormPoint(x, y);
  const r = {
    id,
    field,
    rect: { x: p.x, y: p.y, w: 0.001, h: 0.001 },
  };
  regions = [r, ...regions];
  setActiveRegion(id);
  drag = { type: "create", regionId: id, startRectNorm: { ...r.rect }, startPx: { x, y } };
});

window.addEventListener("mousemove", (e) => {
  if (!drag || !imageBitmap) return;
  const { x, y } = canvasPointFromEvent(e);
  const region = regions.find((r) => r.id === drag.regionId);
  if (!region) return;

  const dx = (x - drag.startPx.x) / (overlay.width || 1);
  const dy = (y - drag.startPx.y) / (overlay.height || 1);

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

  scheduleDrawOverlay();
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  const wasCreate = drag.type === "create";
  const regionId = drag.regionId;
  drag = null;
  if (wasCreate) {
    const region = regions.find((r) => r.id === regionId);
    if (!region || region.rect.w < MIN_REGION_SIZE || region.rect.h < MIN_REGION_SIZE) {
      deleteRegionById(regionId);
      return;
    }
  }
  saveTemplateToStorage();
  renderRegionsUI();
  drawOverlay();
});

loadTemplateFromStorage();
buildCardFieldsGrid();
clearCardFieldsForm();
renderRegionsUI();
drawOverlay();
updateRegistrationFieldValidity();
loadHebrewOcrLexicon();
bindNotesCloudOcrPrefs();
