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

// ── GET / — endpoint docs page ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Anime Proxy — API Docs</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e2e2e2; min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 2.5rem; }
  header h1 { font-size: 1.4rem; font-weight: 600; color: #fff; margin-bottom: 4px; }
  header p { font-size: 13px; color: #888; }
  .section { margin-bottom: 2rem; }
  .section-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #555; margin-bottom: 10px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 10px; }
  .ep-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .method { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: #1a3a2a; color: #4ade80; font-family: monospace; flex-shrink: 0; }
  .path { font-family: monospace; font-size: 14px; color: #fff; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 500; }
  .badge.auto { background: #1a2a3a; color: #60a5fa; }
  .badge.cache { background: #2a2a1a; color: #facc15; }
  .badge.util { background: #1e1e1e; color: #888; border: 1px solid #333; }
  .desc { font-size: 13px; color: #888; margin-bottom: 10px; line-height: 1.5; }
  .params { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .param { font-size: 11px; font-family: monospace; padding: 3px 9px; border-radius: 20px; }
  .param.req { background: #3a1a1a; color: #f87171; }
  .param.opt { background: #1e1e1e; color: #888; border: 1px solid #333; }
  .example-label { font-size: 11px; color: #555; margin-bottom: 4px; margin-top: 8px; }
  .code-row { display: flex; align-items: center; background: #111; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 12px; gap: 10px; cursor: pointer; transition: border-color 0.15s; }
  .code-row:hover { border-color: #444; }
  .code-text { font-family: monospace; font-size: 12px; color: #a3e635; flex: 1; word-break: break-all; }
  .copy-icon { font-size: 13px; color: #555; flex-shrink: 0; transition: color 0.15s; }
  .response { background: #111; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 12px; font-family: monospace; font-size: 11px; color: #888; line-height: 1.8; margin-top: 10px; }
  .res-key { color: #60a5fa; }
  .res-str { color: #4ade80; }
  .res-null { color: #555; }
  .divider { border: none; border-top: 1px solid #1e1e1e; margin: 1.5rem 0; }
  .base-url { font-family: monospace; font-size: 12px; background: #111; border: 1px solid #2a2a2a; border-radius: 6px; padding: 6px 12px; color: #888; display: inline-block; margin-top: 6px; }
  #toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: #1a1a1a; border: 1px solid #333; border-radius: 20px; padding: 6px 16px; font-size: 13px; color: #4ade80; display: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Anime Proxy</h1>
    <p>Proxy server for meguanime &amp; ani.zip — resolves CORS and auto-fills titles from AniList.</p>
    <div class="base-url">Base: http://localhost:${PORT}</div>
  </header>

  <div class="section">
    <p class="section-label">Meguanime — video source</p>
    <div class="card">
      <div class="ep-header">
        <span class="method">GET</span>
        <span class="path">/anineko</span>
        <span class="badge auto">⚡ auto title</span>
      </div>
      <p class="desc">Fetches video source + subtitles for an episode. AniList titles are looked up and cached automatically — only pass <code>al</code>, <code>ep</code>, and <code>lang</code>.</p>
      <div class="params">
        <span class="param req">al — required</span>
        <span class="param req">ep — required</span>
        <span class="param req">lang — required</span>
        <span class="param opt">t — override</span>
        <span class="param opt">t2 — override</span>
      </div>

      <p class="example-label">Episode 1 — subtitles</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/anineko?al=189117&amp;ep=1&amp;lang=sub</span>
        <span class="copy-icon">⎘</span>
      </div>

      <p class="example-label">Episode 5 — dub</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/anineko?al=189117&amp;ep=5&amp;lang=dub</span>
        <span class="copy-icon">⎘</span>
      </div>

      <p class="example-label">Manual title override</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/anineko?al=189117&amp;ep=2&amp;lang=sub&amp;t=Dr.STONE SCIENCE FUTURE&amp;t2=Dr. Stone: Science Future</span>
        <span class="copy-icon">⎘</span>
      </div>

      <div class="response">
{<br>
&nbsp;&nbsp;<span class="res-key">"source"</span>: <span class="res-str">"https://cdn2.meguanime.com/p?u=...master.m3u8..."</span>,<br>
&nbsp;&nbsp;<span class="res-key">"tracks"</span>: [{ <span class="res-key">"file"</span>: <span class="res-str">"...subtitles.vtt"</span>, <span class="res-key">"label"</span>: <span class="res-str">"English"</span>, <span class="res-key">"default"</span>: true }],<br>
&nbsp;&nbsp;<span class="res-key">"intro"</span>: <span class="res-null">null</span>, <span class="res-key">"outro"</span>: <span class="res-null">null</span>, <span class="res-key">"server"</span>: <span class="res-str">"anineko"</span><br>
}
      </div>
    </div>
  </div>

  <hr class="divider" />

  <div class="section">
    <p class="section-label">ani.zip — episode &amp; mapping data</p>
    <div class="card">
      <div class="ep-header">
        <span class="method">GET</span>
        <span class="path">/mappings</span>
      </div>
      <p class="desc">Returns episode list, titles, air dates, ratings and external ID mappings. Pass any one of the supported ID params.</p>
      <div class="params">
        <span class="param opt">anilist_id</span>
        <span class="param opt">mal_id</span>
        <span class="param opt">anidb_id</span>
      </div>

      <p class="example-label">By AniList ID</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/mappings?anilist_id=189117</span>
        <span class="copy-icon">⎘</span>
      </div>

      <p class="example-label">By MAL ID</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/mappings?mal_id=61322</span>
        <span class="copy-icon">⎘</span>
      </div>

      <p class="example-label">By AniDB ID</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/mappings?anidb_id=19248</span>
        <span class="copy-icon">⎘</span>
      </div>
    </div>
  </div>

  <hr class="divider" />

  <div class="section">
    <p class="section-label">Utilities</p>

    <div class="card">
      <div class="ep-header">
        <span class="method">GET</span>
        <span class="path">/title-cache</span>
        <span class="badge cache">in-memory</span>
      </div>
      <p class="desc">Shows all AniList titles cached in memory — eliminates repeated lookups for the same AniList ID.</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/title-cache</span>
        <span class="copy-icon">⎘</span>
      </div>
      <div class="response">
{ <span class="res-key">"189117"</span>: { <span class="res-key">"t"</span>: <span class="res-str">"Dr.STONE SCIENCE FUTURE"</span>, <span class="res-key">"t2"</span>: <span class="res-str">"Dr. Stone: Science Future"</span> } }
      </div>
    </div>

    <div class="card" style="margin-top:10px">
      <div class="ep-header">
        <span class="method">GET</span>
        <span class="path">/health</span>
        <span class="badge util">ping</span>
      </div>
      <p class="desc">Health check — returns 200 OK when the server is running.</p>
      <div class="code-row" onclick="copy(this)">
        <span class="code-text">/health</span>
        <span class="copy-icon">⎘</span>
      </div>
    </div>
  </div>
</div>

<div id="toast">Copied!</div>

<script>
  function copy(el) {
    const raw = el.querySelector('.code-text').textContent.trim()
      .replace(/&amp;/g, '&');
    navigator.clipboard.writeText(raw).catch(() => {});
    el.querySelector('.copy-icon').textContent = '✓';
    setTimeout(() => { el.querySelector('.copy-icon').textContent = '⎘'; }, 1500);
    const t = document.getElementById('toast');
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 1500);
  }
</script>
</body>
</html>`);
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