// Prompt Studio — Render 後端(獨立專案,與 TT2 relay 無關)
// 功能:1) Lemon Squeezy 授權碼驗證  2) 驗證通過後呼叫 OpenAI 產生 Suno Style + 完整歌詞
// 環境變數:
//   OPENAI_API_KEY      必填,你的 OpenAI API key
//   ALLOWED_ORIGIN      前端網址,例如 https://musicsteven.com
//   OPENAI_MODEL        選填,預設 gpt-5.4-mini(若報 model not found,查 platform.openai.com 可用 ID 後填入)
//   LS_STORE_ID         選填,Lemon Squeezy store id(防止別家店的 key)
//   DEMO_LICENSE        選填,測試用授權碼(上線後刪掉)

const express = require("express");

const app = express();
app.use(express.json({ limit: "50kb" }));

// ---------- CORS ----------
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

// ---------- 授權碼驗證(Lemon Squeezy) ----------
const licCache = new Map(); // key -> { valid, exp }
const CACHE_MS = 10 * 60 * 1000;

async function checkLicense(key) {
  if (!key || typeof key !== "string" || key.length > 64) return false;
  if (process.env.DEMO_LICENSE && key === process.env.DEMO_LICENSE) return true;

  const hit = licCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.valid;

  let valid = false;
  try {
    const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key }),
    });
    const j = await r.json();
    valid = j.valid === true && j.license_key?.status === "active";
    if (valid && process.env.LS_STORE_ID) {
      valid = String(j.meta?.store_id) === String(process.env.LS_STORE_ID);
    }
  } catch (e) {
    console.error("LS validate error:", e.message);
  }
  licCache.set(key, { valid, exp: Date.now() + CACHE_MS });
  return valid;
}

// ---------- 每組授權碼的每日用量限制 ----------
const usage = new Map(); // key -> { day, count }
const DAILY_LIMIT = 100;
function useOnce(key) {
  const today = new Date().toISOString().slice(0, 10);
  let u = usage.get(key);
  if (!u || u.day !== today) { u = { day: today, count: 0 }; usage.set(key, u); }
  if (u.count >= DAILY_LIMIT) return -1;          // 已達上限
  u.count++;
  return DAILY_LIMIT - u.count;                    // 回傳今日剩餘次數
}

// ---------- Routes ----------
app.get("/", (req, res) => res.json({ ok: true, service: "prompt-studio" }));

app.post("/api/verify", async (req, res) => {
  const valid = await checkLicense(req.body?.license);
  res.json({ valid });
});

app.post("/api/enhance", async (req, res) => {
  const { license, brief } = req.body || {};
  if (!(await checkLicense(license))) return res.status(403).json({ error: "invalid_license" });
  const remaining = useOnce(license);
  if (remaining < 0) return res.status(429).json({ error: "daily_limit", remaining: 0 });
  if (!brief || typeof brief !== "string" || brief.length > 2000)
    return res.status(400).json({ error: "bad_brief" });

  const lang = req.body.lang === "zh" ? "Traditional Chinese" : "English";
  const system =
    "You are an expert Suno prompt engineer and songwriter. " +
    "Respond ONLY with raw JSON, no markdown fences, exactly: " +
    '{"style":"...","lyrics":"...","exclude":"...","title":"...","description":"..."} . ' +
    "style: comma-separated Suno style prompt, order genre->mood->instruments->vocals->production, " +
    "15-30 descriptors, STRICTLY under 200 characters. " +
    "lyrics: complete original song lyrics written in the lyrics language given in the brief, " +
    "with structure tags [Intro][Verse 1][Pre-Chorus][Chorus][Verse 2][Bridge][Final Chorus][Outro], " +
    'conversational lines of 6-10 syllables, chorus hook repeated; if Instrumental is yes, return "[Instrumental]". ' +
    "exclude: up to 5 comma-separated things to avoid. " +
    "title: catchy song title in the lyrics language. " +
    "description: 2 sentences in " + lang + ".";

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: brief },
        ],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "openai_error");
    const txt = (j.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const data = JSON.parse(txt);
    if (!data.style || !data.lyrics) throw new Error("bad shape");
    data.remaining = remaining;
    res.json(data);
  } catch (e) {
    console.error("enhance error:", e.message);
    res.status(500).json({ error: "enhance_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Prompt Studio server on :" + PORT));
