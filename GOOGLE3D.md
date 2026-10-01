# Google Photorealistic 3D Tiles: owner setup

The 3D view can show the real Google Earth-style city around Barreiro 2, with our building in its plot. The old empty lot is hidden.
This only works on your own hosting (Netlify, Cloudflare Pages, GitHub Pages or your own domain). Inside claude.ai the
Google tile servers are blocked. Without a key, or whenever anything fails, the site quietly uses its built-in
OpenStreetMap neighbourhood instead.

## 1. Get a key
1. Go to <https://console.cloud.google.com/>, create a project (for example "vilnyi-site") and **link a billing account**. Google requires one even for free usage.
2. Open *APIs & Services → Library*, search for **Map Tiles API** and click **Enable**.
3. Open *APIs & Services → Credentials → Create credentials → API key*.

## 2. Restrict the key (important: the key is visible in the page source)
Edit the key:
- **Application restrictions → Websites (HTTP referrers)**. Add each address the site runs on, for example
  `https://barreiro2.example.com/*`, `https://*.netlify.app/*` (or your exact Netlify URL) and `http://localhost:*/*` for testing.
- **API restrictions → Restrict key → Map Tiles API** only.
- Optional: in *Quotas* for the Map Tiles API, set a low daily cap so a leaked key can't run up a bill.

## 3. Put the key in the site
In `js/data.js`, set `PROJECT.googleMapsKey: 'AIza…'` and redeploy. That's all.

## Costs and limits (from my knowledge as of 2025–2026; they may have changed, so check the official pages)
- Billing is per **root tileset request**. That is one per visitor "session", and a session lasts about 3 hours. The individual tile downloads inside a session are not billed separately.
- Google used to give a US$200 monthly credit. Since March 2025 it gives a **free monthly usage cap per product** instead.
  Above that cap, 3D Tiles has been priced at a few US dollars per 1,000 root requests, with volume discounts.
  Current prices: <https://mapsplatform.google.com/pricing/> · Map Tiles API usage and billing: <https://developers.google.com/maps/documentation/tile/usage-and-billing>.
- There are default per-minute and per-day request quotas. You can see and lower them in the Cloud Console.
- Google's terms: the **Google logo and data attributions must stay visible**. The site shows them bottom-left over the 3D view. Keep them uncovered.
  Tiles must not be cached or downloaded for offline use. The Map Tiles API policies also cover how imagery can be shown alongside your own content.
  Please read <https://developers.google.com/maps/documentation/tile/policies> and check that hiding the tiles inside our own plot
  (so the planned building replaces the empty lot) is acceptable for your use.
- Mobile phones stream less detail to save data and memory.

## Troubleshooting
If you still see the simple neighbourhood instead of Google's: the key is missing or wrong, the Map Tiles API is not enabled, billing is not active,
or the site address isn't in the key's referrer list. The browser console (F12) will show a 403 error from `tile.googleapis.com`.

---

## תקציר בעברית
- התצוגה התלת-ממדית יכולה להציג את הסביבה האמיתית של Google (כמו Google Earth) סביב הבניין, והמגרש הריק הישן מוסתר.
  זה עובד רק באתר שמתארח אצלכם (Netlify / Cloudflare / דומיין עצמי), לא בתוך claude.ai. בלי מפתח, או כשמשהו נכשל, האתר מציג אוטומטית את סביבת OpenStreetMap הרגילה.
- **יצירת מפתח:** ב-Google Cloud Console יוצרים פרויקט, מחברים חשבון חיוב, מפעילים את **Map Tiles API** ויוצרים API key.
- **הגבלת המפתח (חובה, כי הוא גלוי בקוד):** מגבילים ל-HTTP referrers של כתובות האתר שלכם, ומגבילים את ה-API ל-Map Tiles API בלבד. מומלץ גם להגדיר מכסה יומית נמוכה.
- **הפעלה:** מכניסים את המפתח ב-`js/data.js` בשדה `PROJECT.googleMapsKey` ומעלים את האתר מחדש.
- **עלויות:** החיוב הוא לפי "סשן" של מבקר (בערך 3 שעות), ויש מכסה חודשית חינמית. המחירים והמכסות עשויים להשתנות, אז כדאי לבדוק בדף התמחור של Google.
- הלוגו של Google והקרדיטים חייבים להישאר גלויים (הם מוצגים בפינה השמאלית התחתונה). כדאי לבדוק במדיניות של Google שהסתרת האריחים בתוך המגרש שלנו מותרת לשימוש שלכם.
