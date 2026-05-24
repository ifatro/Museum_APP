# Museum Card Scanner (Local, Web)

אפליקציית ווב ל-OCR כרטיסיות מוזיאון: **רוב השדות מקומית** (Tesseract בדפדפן), **הערות בכתב יד** — אופציונלית דרך **Google Cloud Vision** (רק חיתוך מלבן ההערות).

## הפעלה מהירה (מומלץ)

```bash
npm install
cp .env.example .env
# ערכו GOOGLE_CLOUD_VISION_API_KEY ב-.env
npm start
```

פתחו בדפדפן: [http://localhost:3921/index.html](http://localhost:3921/index.html)

1. העלאת תמונה
2. סימון ROI (מלבנים צהובים) — כולל **הערות**
3. סימון **OCR הערות (Google Vision)** אם רוצים כתב יד בענן
4. **Run OCR**

## OCR מקומי (ברירת מחדל)

- Tesseract.js (`heb+eng`) — כל השדות מלבד הערות בענן
- תבנית ROI נשמרת ב-LocalStorage
- מילון תיקון י׳/ל׳: `hebrew-ocr-lexicon.json`

פתיחת `index.html` ישירות (ללא `npm start`) עובדת ל-OCR מקומי בלבד; **OCR הערות בענן דורש את ה-proxy** (`npm start`).

## OCR הערות — Google Cloud Vision

| מה נשלח | מה לא |
|---------|--------|
| תמונת PNG של **מלבן שדה הערות** בלבד | שאר הכרטיס, שאר השדות |

### הגדרה

1. [הפעילו Vision API](https://console.cloud.google.com/apis/library/vision.googleapis.com) בפרויקט Google Cloud
2. צרו מפתח API והדביקו ב-`.env`:

```env
GOOGLE_CLOUD_VISION_API_KEY=your_key_here
```

3. `npm start` — שרת proxy על פורט 3921 (מגיש גם את האתר הסטטי)
4. באפליקציה: סמנו **OCR הערות (Google Vision)**

אם הקריאה לענן נכשלת — יש נפילה אוטומטית ל-Tesseract מקומי על אותו ROI.

### בדיקת proxy

```bash
curl http://localhost:3921/api/health
```

## פרטיות

- שדות מודפסים: עיבוד בדפדפן (Tesseract נטען מ-CDN; מודלי שפה נטענים בזמן ריצה)
- הערות + Google: רק crop ההערות → שרת **מקומי** שלכם → Google Vision (לפי מדיניות Google)

## עקרונות עיבוד (שדות ו-OCR)

| נושא | התנהגות |
|------|---------|
| מס' רשום | `M` + 2 אותיות לטיניות + רווח + 5 ספרות; **MHP** גובר על **MEP** באותן ספרות |
| תוויות | הערך בלי תווית הכרטיס (`חומר`, `תקופה`, `הערות`…) — רק תוכן |
| מסגרת | הסרת `|`, נקודות זוטרות מקווי טבלה (לא עשרוניים במידות) |
| רווחים | רווח יחיד בין מילים; שדות ארוכים שומרים שורות |
| עברית י׳/ל׳ | `hebrew-ocr-lexicon.json` — תיקון שמרני, לא החלפת כל `ל` בטקסט |
| הערות בענן | רק חיתוך ROI של **הערות** → proxy מקומי → Google Vision |

למפתחים ב-Cursor: `.cursor/rules/museum-app-core.mdc`, `museum-ocr.mdc`.

## בדיקות

```bash
npm run test:lexicon
```

## קבצים עיקריים

| קובץ | תפקיד |
|------|--------|
| `index.html`, `app.js`, `styles.css` | ממשק ו-OCR |
| `hebrew-ocr-lexicon.json` | מילון תיקון עברית |
| `server/vision-proxy.mjs` | Proxy מקומי ל-Google Vision |
| `.env` | מפתח API (לא ב-git) |
