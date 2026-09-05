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

// ── Resolve the public base URL of this server ─────────────────────────────
// Set the PROXY_BASE env var to your Vercel URL in production, e.g.:
//   PROXY_BASE=https://neko-api-six.vercel.app
// Falls back to localhost for local dev.
function getBase(req) {
  if (process.env.PROXY_BASE) return process.env.PROXY_BASE;

  // Vercel/reverse-proxies terminate SSL and forward as http internally.
  // Trust the X-Forwarded-Proto header to get the real protocol.
  const proto =
    req.headers["x-forwarded-proto"]?.split(",")[0].trim() ??
    req.protocol;

  return `${proto}://${req.get("host")}`;
}

// ── Rewrite a CDN URL → /proxy/stream?url=... or /proxy/vtt?url=... ────────
function rewriteUrl(cdnUrl, type, req) {
  const base = getBase(req);
  return `${base}/proxy/${type}?url=${encodeURIComponent(cdnUrl)}`;
}

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

// ── GET /anineko?al=&ep=&lang= ────────────────────────────────────────────
app.get("/anineko", async (req, res) => {
  const { al, ep, lang = "sub" } = req.query;

  if (!al || !ep) {
    return res.status(400).json({ ok: false, error: "Missing required params: al, ep" });
  }

  try {
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

    // ── Rewrite source & tracks URLs so the browser never hits the CDN directly ──
    if (data.source) {
      data.source = rewriteUrl(data.source, "stream", req);
    }
    if (Array.isArray(data.tracks)) {
      data.tracks = data.tracks.map((track) => ({
        ...track,
        file: track.file ? rewriteUrl(track.file, "vtt", req) : track.file,
      }));
    }

    res.json(data);
  } catch (err) {
    console.error("[anineko]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /proxy/stream?url= — HLS master.m3u8 passthrough ─────────────────
// Streams the m3u8 (and rewrites segment/key URLs inside it) or the raw
// TS/fMP4 segments when the player follows the rewritten segment URLs.
app.get("/proxy/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url param");

  try {
    const upstream = await fetch(decodeURIComponent(url), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer":    "https://meguanime.com/",
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", contentType);

    // If this is an m3u8 playlist, rewrite internal URLs so segments
    // also route through this proxy (handles both master and media playlists).
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      url.includes(".m3u8")
    ) {
      const text  = await upstream.text();
      const base  = getBase(req);
      // Resolve each line that isn't a comment relative to the original URL
      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;

          // Build an absolute URL for the segment/key
          let abs;
          try {
            abs = new URL(trimmed, decodeURIComponent(url)).href;
          } catch {
            abs = trimmed; // already absolute or malformed — leave as-is
          }

          // Rewrite through our proxy
          return `${base}/proxy/stream?url=${encodeURIComponent(abs)}`;
        })
        .join("\n");

      return res.send(rewritten);
    }

    // Binary passthrough (TS segments, key files, fMP4 chunks, etc.)
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[proxy/stream]", err.message);
    res.status(502).send(err.message);
  }
});

// ── GET /proxy/vtt?url= — subtitle VTT passthrough ───────────────────────
app.get("/proxy/vtt", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url param");

  try {
    const upstream = await fetch(decodeURIComponent(url), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer":    "https://meguanime.com/",
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error ${upstream.status}`);
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "text/vtt; charset=utf-8");
    // Optional: let CDNs/browsers cache subtitles for 10 min
    res.set("Cache-Control", "public, max-age=600");

    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    console.error("[proxy/vtt]", err.message);
    res.status(502).send(err.message);
  }
});

// ── GET /health ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── GET /title-cache ──────────────────────────────────────────────────────
app.get("/title-cache", (_req, res) => res.json(Object.fromEntries(titleCache)));

// ── GET / ─────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({
  status: "ok",
  endpoints: {
    "/anineko": {
      params: { al: "required", ep: "required", lang: "sub | dub", t: "optional", t2: "optional" },
      example: "/anineko?al=189117&ep=1&lang=sub"
    },
    "/mappings": {
      params: { anilist_id: "optional", mal_id: "optional", anidb_id: "optional" },
      example: "/mappings?anilist_id=189117"
    },
    "/proxy/stream": {
      params: { url: "required (encoded CDN url)" },
      example: "/proxy/stream?url=https%3A%2F%2Fcdn2.meguanime.com%2F..."
    },
    "/proxy/vtt": {
      params: { url: "required (encoded CDN url)" },
      example: "/proxy/vtt?url=https%3A%2F%2Fcdn2.meguanime.com%2F..."
    },
    "/title-cache": "GET — returns all cached AniList titles",
    "/health":      "GET — returns { status: ok }"
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProxy → http://localhost:${PORT}`);
});