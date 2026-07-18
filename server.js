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
const DAILY_LIMIT = 30;
function useOnce(key) {
  const today = new Date().toISOString().slice(0, 10);
  let u = usage.get(key);
  if (!u || u.day !== today) { u = { day: today, count: 0 }; usage.set(key, u); }
  if (u.count >= DAILY_LIMIT) return -1;          // 已達上限
  u.count++;
  return DAILY_LIMIT - u.count;                    // 回傳今日剩餘次數
}


// ---------- 專家知識庫(Steven 音樂專業 × Suno v5.5 最佳實務) ----------
const EXPERT_RULES = [
"SUNO v5.5 STYLE FIELD CRAFT:",
"- Open with tempo (BPM) + key suggestion + one primary genre descriptor.",
"- Name at least 2 instruments, each with a vivid adjective (e.g. 'slightly detuned vintage keys', 'glitchy hi-hat rolls', 'close-mic breathiness') — v5.5 rewards subtle, specific descriptors.",
"- Use 8-15 tags total, roughly one per category: genre / mood / instrumentation / vocal timbre / production.",
"- Vocal timbre vocabulary: smoky, airy, bright, warm, raspy, velvety, breathy, powerful belt.",
"- Production vocabulary: analog warmth, tape saturation, wide stereo image, punchy low end, glued bus compression, tasteful sidechain.",
"- Put things to AVOID at the very END of the style string as negatives when helpful.",
"LYRICS FIELD CRAFT (all languages):",
"- Structure tags on their own lines: [Intro][Verse 1][Pre-Chorus][Chorus][Verse 2][Bridge][Final Chorus][Outro].",
"- May add delivery tags where musically justified: [Whispered], [Belted], [Spoken], [Harmonies], [Ad-libs].",
"- Conversational register; chorus hook stated early and repeated verbatim; verses advance concrete imagery, chorus distills one emotion; bridge shifts perspective.",
"- Prosody first: stressed syllables / strong beats must land on strong words; never force rhyme at the cost of natural speech."
].join("\n");

// 每種曲風:常用和弦進行 + 樂器配置 + 律動/製作語彙
const GENRE_KB = {
  "pop":        "chords: I-V-vi-IV or vi-IV-I-V, add a borrowed iv or bVII for color; instruments: polished piano or bright synth stack, tight drum kit, round bass, layered stacked chorus vocals; craft: earworm hook, pre-chorus lift, final-chorus ad-libs",
  "rock":       "chords: I-bVII-IV (Mixolydian) or i-bVI-bVII power-chord riffs; instruments: crunchy rhythm electric guitars L/R, driving eighth-note bass, live room drums, lead guitar solo in bridge; craft: anthemic gang-vocal chorus, dynamic quiet-verse loud-chorus",
  "hip-hop":    "chords: 2-4 bar minor loop (i-bVI or i-iv), dark bell/piano motif; instruments: booming 808 sub with tuned glides, crisp trap hi-hat rolls, snare/clap on 3, sparse keys; craft: flow switches between sections, space for the vocal to breathe",
  "r&b":        "chords: neo-soul ii9-V13-Imaj9 movement, chromatic passing chords; instruments: warm Rhodes, clean muted guitar licks, pocket drums slightly behind the beat, silky stacked harmonies; craft: melisma-friendly melody, call-and-response ad-libs",
  "edm":        "chords: vi-IV-I-V lifted anthem loop or minor i-bVI-III-bVII; instruments: supersaw lead stacks, sidechained pads over four-on-the-floor kick, rolling sub bass, white-noise risers; craft: 8-bar build with snare roll into a wide drop",
  "lo-fi":      "chords: jazzy ii7-V7-Imaj7 with 9ths, or looping Imaj7-vi7; instruments: dusty Rhodes or nylon guitar loop, lazily swung MPC drums, muted upright bass, vinyl crackle; craft: tape saturation, lo-pass warmth, imperfect human timing",
  "jazz":       "chords: ii-V-I with alterations (b9, #11, 13), tritone subs, turnarounds; instruments: piano or guitar comping, walking upright bass, brushed drums, expressive horn lead; craft: swing feel, conversational interplay, head-solo-head form",
  "blues":      "chords: 12-bar I7-IV7-V7 with quick change; instruments: gritty electric guitar with string bends, shuffle drums, honky-tonk piano or harmonica; craft: call-and-response between voice and guitar, behind-the-beat phrasing",
  "classical":  "harmony: functional tonal harmony with secondary dominants, clear cadences, period-appropriate counterpoint; instruments: strings, woodwinds, horns or solo piano; craft: rubato phrasing, dynamic arcs pianissimo to fortissimo, thematic development",
  "cinematic":  "harmony: minor ostinato with pedal tones, chromatic mediant shifts (i-bVI, I-bIII) for awe; instruments: string ostinato, French horn swells, taiko and low percussion, choir pads, soaring legato theme; craft: slow build, huge dynamic range, trailer-scale climax",
  "folk":       "chords: I-IV-V and relative-minor moves, open-string voicings, capo colors; instruments: fingerpicked acoustic guitar, intimate close-mic vocal, subtle fiddle/harmonica/mandolin; craft: storytelling verses, warm organic room sound",
  "country":    "chords: I-IV-V with a vi-IV bridge, occasional truck-driver key change; instruments: twangy Telecaster licks, pedal steel swells, acoustic strum, train-beat drums; craft: narrative concrete lyrics, big singalong chorus",
  "metal":      "chords: drop-tuned power riffs, i-bII (Phrygian) menace, pedal-point chugs; instruments: palm-muted rhythm guitars doubled, double-kick drums, growled or soaring clean vocals; craft: tight percussive riffing, breakdown before final chorus",
  "funk":       "chords: one-chord E9/dominant-9 vamps, short ii-V turnarounds; instruments: syncopated 16th-note scratch guitar, slap bass popping, tight horn stabs, clavinet; craft: emphasis on the One, in-the-pocket drums, space is the groove",
  "reggae":     "chords: I-IV or i-bVII two-chord vamps; instruments: off-beat skank guitar chops, deep round one-drop bass, bubbling organ, sparse percussion; craft: laid-back groove, dubby spring-reverb accents",
  "ambient":    "harmony: static or glacially shifting Lydian/major-7 pads, drones with slow suspensions; instruments: evolving synth pad layers, shimmer reverb tails, field-recording textures, optional slow piano motifs; craft: no drums or heartbeat-slow pulse, meditative stillness",
  "city pop":   "chords: maj7/9 harmony, IVmaj7-iii7-vi9 motion, ii-V into relative keys; instruments: chorused clean electric guitar, slap bass, DX7 electric piano sparkle, tight 80s drums with gated reverb; craft: Tokyo night-drive nostalgia, sax or synth solo",
  "mandopop":   "chords: piano ballad 4536 progression (I-V/vii-vi-iii-IV...) i.e. C-G/B-Am-Em-F-C-Dm-G family, final-chorus key lift; instruments: piano-driven with string pads, melodic guitar counter-lines, soft drums entering at chorus; craft: breathy intimate verse rising to a soaring belted chorus",
  "k-pop":      "chords: bright IV-V-iii-vi loops with section-to-section genre switches; instruments: stacked synth hooks, punchy modern drums, chant-along post-chorus, rap-bridge beat switch; craft: meticulous vocal layering, killing-part hook",
  "bossa nova": "chords: m7/maj7 harmony with chromatic descending lines (Imaj7-bIIdim-ii7-V7b9); instruments: syncopated nylon-string guitar comping, soft brushed drums, muted upright bass, airy flute or trombone; craft: cool understated vocal, gentle Rio sway",
  "synthwave":  "chords: minor i-bVI-bIII-bVII loops; instruments: analog arpeggios, gated-reverb snare, neon retro pads, chugging bass sequencer; craft: 80s nostalgia with modern low end, slow filter opens",
  "orchestral": "harmony: full functional palette with contrapuntal inner voices, brass chorales, suspensions and resolutions; instruments: full symphony — string runs, horn calls, timpani rolls, harp sweeps; craft: cathedral-scale reverb, clear thematic statement and development"
};

// 每種歌詞語言:填詞工藝規則
const LANG_KB = {
  "mandarin":   "MANDARIN LYRICS: natural spoken Taiwanese-Mandarin phrasing, absolutely no translationese; coherent rhyme scheme (AABB or ABAB) using Mandarin rime families; mind the four tones — melody peaks should fall on syllables whose tone rises or stays high so the words sing naturally; concrete imagery (rain, streetlights, seasons) over abstract nouns; chorus hook of 6-9 characters, repeated verbatim.",
  "cantonese":  "CANTONESE LYRICS: MUST follow 協音 (tone-melody matching) — Cantonese has 6+ tones and lyrics that ignore tone contour sound wrong when sung; use colloquial Hong Kong Cantonese vocabulary (唔/嘅/喺) or literary register consistently, never mix carelessly; rhyme on Cantonese finals; short punchy lines suit the language.",
  "english":    "ENGLISH LYRICS: align lexical stress with strong beats; favor concrete verbs and sensory nouns; use internal rhyme and assonance, not only end-rhyme; conversational contractions (I'm, don't); chorus hook of 3-7 words, title appears in the hook.",
  "japanese":   "JAPANESE LYRICS: mora-based phrasing — keep lines light, avoid cramming morae; natural particle placement; seasonal/scenic imagery (夏, 夜風, 桜) suits J-pop; a few English hook words acceptable in chorus if genre-appropriate; avoid direct-translation word order.",
  "korean":     "KOREAN LYRICS: smooth batchim flow — avoid consonant-cluster pileups on fast passages; K-pop convention allows a short English hook line blended into Korean chorus; repetition of the killing-part hook; natural 해요체/반말 register matched to song mood.",
  "spanish":    "SPANISH LYRICS: vowel-rich end rhymes come naturally — vary with asonante rhyme; align stressed syllables (palabras llanas/agudas) with the beat; warm direct address (tú/contigo); imagery of light, sea, night suits Latin pop and bossa."
};

function kbNotes(brief) {
  const out = [];
  // 精準比對 Genre 行,避免 "Pop" 誤中 "City Pop / K-Pop / Mandopop"
  const gm = brief.match(/Genre:\s*([^\n]*)/i);
  if (gm) {
    const genres = gm[1].split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    for (const g of genres) {
      const key = g === "mandopop" ? "mandopop" : g; // 前端傳英文名,直接對 key
      if (GENRE_KB[key]) out.push(key.toUpperCase() + " — " + GENRE_KB[key]);
    }
  }
  const lm = brief.match(/Lyrics language:\s*([^\n]*)/i);
  if (lm) {
    const lk = lm[1].trim().toLowerCase().split(" ")[0]; // "Mandarin", "Instrumental (no lyrics)" -> "instrumental"
    if (LANG_KB[lk]) out.push(LANG_KB[lk]);
  }
  return out.length
    ? "\n\nCRAFT DATABASE (authoritative — weave these chord progressions, instrumentation and lyric rules into the output):\n" + out.join("\n")
    : "";
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
    "description: 2 sentences in " + lang + ". " +
    "Write like a seasoned producer-songwriter, not a keyword stuffer: every descriptor must be specific and musically meaningful.\n\n" +
    EXPERT_RULES + kbNotes(brief);

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
