# Museum Card Scanner — agent notes

## Run

```bash
npm install
cp .env.example .env   # GOOGLE_CLOUD_VISION_API_KEY for notes OCR
npm start              # http://localhost:3921/index.html
npm run test:lexicon
```

## Principles (source of truth in code)

Follow `.cursor/rules/museum-app-core.mdc` and `museum-ocr.mdc`:

- **Fields:** `CARD_FORM_FIELDS` in `app.js`
- **Finalize:** `finalizeOcrFieldValue`, `finalizeManualFieldValue`, `polishFieldSpacing`, `stripKnownLabelPrefix`, `stripFrameArtifacts`
- **Registration:** `canonicalRegistration` — `MXX #####` only; prefer **MHP** over **MEP**
- **Hebrew:** extend `hebrew-ocr-lexicon.json`; use `applyHebrewFieldCorrection`, not global ל↔י
- **Notes cloud OCR:** `server/vision-proxy.mjs` — **notes ROI crop only**

Minimal diffs. Commit only when the user asks.
