import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

const PORT = Number(process.env.PORT) || 3921;
const API_KEY = process.env.GOOGLE_CLOUD_VISION_API_KEY;

const app = express();
app.use(express.json({ limit: "12mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    visionConfigured: Boolean(API_KEY),
  });
});

/** OCR on notes ROI crop only — forwards to Google Cloud Vision */
app.post("/api/ocr/notes", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Missing GOOGLE_CLOUD_VISION_API_KEY in .env (see .env.example)",
    });
  }

  const imageBase64 = `${req.body?.imageBase64 ?? ""}`.trim();
  if (!imageBase64) {
    return res.status(400).json({ error: "imageBase64 is required" });
  }

  const content = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.+-]+;base64,/, "");

  try {
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              imageContext: { languageHints: ["he", "iw"] },
            },
          ],
        }),
      },
    );

    const payload = await visionRes.json().catch(() => ({}));
    if (!visionRes.ok) {
      const msg =
        payload?.error?.message ||
        `Google Vision HTTP ${visionRes.status}`;
      return res.status(502).json({ error: msg });
    }

    const first = payload?.responses?.[0];
    if (first?.error) {
      return res.status(502).json({ error: first.error.message || "Vision API error" });
    }

    const text =
      first?.fullTextAnnotation?.text ||
      first?.textAnnotations?.[0]?.description ||
      "";

    res.json({
      text,
      source: "google_vision",
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || "Vision proxy failed",
    });
  }
});

app.use(express.static(rootDir));

app.listen(PORT, () => {
  console.log(`Museum Card Scanner: http://localhost:${PORT}/index.html`);
  console.log(
    API_KEY
      ? "Google Vision: API key loaded"
      : "Google Vision: set GOOGLE_CLOUD_VISION_API_KEY in .env",
  );
});
