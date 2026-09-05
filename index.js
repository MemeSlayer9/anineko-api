const express = require("express");
const cors    = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANI_ZIP_BASE  = "https://api.ani.zip";
const ANILIST_GQL   = "https://graphql.anilist.co";
const MEGU_BASE     = "https://meguanime.com/api/anineko";

// ── In-memory title cache (anilistId → { t, t2 }) ─────────────────────────
const titleCache = new Map();

// ── Fetch titles from AniList ──────────────────────────────────────────────
async function fetchAnilistTitles(anilistId) {
  if (titleCache.has(String(anilistId))) {
    console.log(`[cache] title hit → ${anilistId}`);
    return titleCache.get(String(anilistId));
  }

  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        title { romaji english native }
        synonyms
      }
    }
  `;

  const r = await fetch(ANILIST_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body:    JSON.stringify({ query, variables: { id: parseInt(anilistId) } }),
  });

  const json = await r.json();
  if (json.errors) throw new Error(json.errors[0].message);

  const { title, synonyms } = json.data.Media;

  // t  = romaji (what meguanime uses as primary)
  // t2 = english (fallback to first synonym if no english)
  const t  = title.romaji  ?? title.english ?? title.native ?? "";
  const t2 = title.english ?? (synonyms?.[0] ?? t);

  const result = { t, t2 };
  titleCache.set(String(anilistId), result);
  console.log(`[anilist] ${anilistId} → t="${t}" t2="${t2}"`);
  return result;
}

// ── GET /mappings?anilist_id= ─────────────────────────────────────────────
app.get("/mappings", async (req, res) => {
  const params = new URLSearchParams(req.query).toString();
  const url    = `${ANI_ZIP_BASE}/mappings${params ? `?${params}` : ""}`;
  console.log(`[proxy] → ${url}`);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Upstream ${r.status}` });
    res.set("Cache-Control", "public, max-age=600");
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /anineko?al=189117&ep=2&lang=sub ─────────────────────────────────
//
//  Required params:
//    al   — AniList ID
//    ep   — episode number
//    lang — "sub" | "dub"
//
//  Optional overrides (skip auto-lookup if you already know them):
//    t    — romaji title
//    t2   — english title
//
//  Returns the meguanime JSON as-is:
//    { source, tracks, intro, outro, server }
// ─────────────────────────────────────────────────────────────────────────
app.get("/anineko", async (req, res) => {
  const { al, ep, lang = "sub" } = req.query;

  if (!al || !ep) {
    return res.status(400).json({ ok: false, error: "Missing required params: al, ep" });
  }

  try {
    // Resolve t / t2 — use caller-supplied values first, then auto-lookup
    let t  = req.query.t;
    let t2 = req.query.t2;

    if (!t || !t2) {
      const titles = await fetchAnilistTitles(al);
      t  = t  ?? titles.t;
      t2 = t2 ?? titles.t2;
    }

    const params = new URLSearchParams({ al, ep, lang, t, t2 }).toString();
    const url    = `${MEGU_BASE}?${params}`;
    console.log(`[megu] → ${url}`);

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer":    "https://meguanime.com/",
        Accept:       "application/json",
      },
    });

    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Upstream ${r.status}` });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error("[anineko]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── GET /title-cache ──────────────────────────────────────────────────────
app.get("/title-cache", (_req, res) => res.json(Object.fromEntries(titleCache)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProxy → http://localhost:${PORT}`);
  console.log(`  ani.zip    GET /mappings?anilist_id=189117`);
  console.log(`  meguanime  GET /anineko?al=189117&ep=2&lang=sub`);
  console.log(`  title cache GET /title-cache\n`);
});