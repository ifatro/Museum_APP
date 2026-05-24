const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "hebrew-ocr-lexicon.json"), "utf8"));

const words = new Set();
for (const w of data.words ?? []) words.add(`${w}`.trim());
for (const [from, to] of data.replacements ?? []) {
  if (to) words.add(`${to}`.trim());
}
const replacements = (data.replacements ?? [])
  .filter((p) => Array.isArray(p) && p[0] && p[1])
  .map(([from, to]) => ({ from: `${from}`, to: `${to}` }))
  .sort((a, b) => b.from.length - a.from.length);

function lamedYodSingleSwapVariants(word) {
  const variants = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "ל") variants.push(word.slice(0, i) + "י" + word.slice(i + 1));
    else if (word[i] === "י") variants.push(word.slice(0, i) + "ל" + word.slice(i + 1));
  }
  return variants;
}

function fixHebrewWordWithLexicon(word) {
  if (!word || words.has(word)) return word;
  const candidates = lamedYodSingleSwapVariants(word).filter((v) => words.has(v));
  return candidates.length === 1 ? candidates[0] : word;
}

function applyHebrewOcrLexicon(text) {
  let t = `${text ?? ""}`;
  for (const { from, to } of replacements) {
    if (t.includes(from)) t = t.split(from).join(to);
  }
  return t.replace(/[\u0590-\u05FF]+/g, (word) => fixHebrewWordWithLexicon(word));
}

const cases = data.testCases ?? [];
let failed = 0;
for (const { input, expected } of cases) {
  const got = applyHebrewOcrLexicon(input);
  if (got !== expected) {
    failed += 1;
    console.error(`FAIL: "${input}" => "${got}" (expected "${expected}")`);
  }
}
if (failed) process.exit(1);
console.log(`Hebrew lexicon: ${cases.length} tests OK`);
