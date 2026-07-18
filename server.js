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
"- ERA-SENSITIVE GENRES: when a genre entry has an ERA ANCHOR, the style prompt MUST include that era phrase and era-correct production descriptors; copy that entry EXCLUDE items into the exclude output field.",
"- BRIGHTNESS: for vintage genres, explicitly request airy bright top end / sparkling highs — AI mixes default too dark.",
"- HARD CONSTRAINTS: if the brief specifies Key, Chord progression, Era, Vocal timbre, Production texture or Song structure, treat them as non-negotiable: reflect the key and progression in the style prompt wording, follow the requested structure exactly in the lyrics tags, and weave timbre/texture words into vocal and production descriptors.",
"LYRICS FIELD CRAFT (all languages):",
"- Structure tags on their own lines: [Intro][Verse 1][Pre-Chorus][Chorus][Verse 2][Bridge][Final Chorus][Outro].",
"- May add delivery tags where musically justified: [Whispered], [Belted], [Spoken], [Harmonies], [Ad-libs].",
"- Conversational register; chorus hook stated early and repeated verbatim; verses advance concrete imagery, chorus distills one emotion; bridge shifts perspective.",
"- Prosody first: stressed syllables / strong beats must land on strong words; never force rhyme at the cost of natural speech."
].join("\n");

// 每種曲風:常用和弦進行 + 樂器配置 + 律動/製作語彙
const GENRE_KB = {
  "pop":        "tempo 95-120 BPM; chords: I-V-vi-IV or vi-IV-I-V, borrow iv or bVII for color; instruments: polished piano or bright synth stack, tight punchy kit, round bass, layered stacked chorus vocals; vocal: clear bright lead with doubled chorus; form: verse-prechorus-chorus, final-chorus ad-libs; production: radio-ready loudness, wide chorus, glued bus compression",
  "rock":       "tempo 110-150 BPM; chords: I-bVII-IV Mixolydian riffs or i-bVI-bVII; instruments: crunchy rhythm electric guitars panned L/R, driving eighth-note bass, live room drums, lead guitar solo in bridge; vocal: gritty powerful lead, gang-vocal chorus; production: analog console warmth, natural drum room, quiet-verse loud-chorus dynamics",
  "hip-hop":    "tempo 70-95 BPM (or 140 double-time trap); chords: 2-4 bar dark minor loop (i-bVI), bell or piano motif; instruments: booming 808 sub with tuned glides, crisp rolling trap hi-hats, hard clap on 3, sparse keys; vocal: confident rhythmic flow, flow-switches per section, ad-lib layer; production: heavy low end, vocal upfront and dry",
  "r&b":        "tempo 60-90 BPM; chords: neo-soul ii9-V13-Imaj9, chromatic passing chords; instruments: warm Rhodes, clean muted guitar licks, pocket drums behind the beat, sub-friendly bass; vocal: silky melisma lead, stacked BGV harmonies, falsetto touches; production: smooth top end, intimate close-mic verses",
  "edm":        "tempo 124-132 BPM; chords: lifted vi-IV-I-V anthem loop or minor i-bVI-III-bVII; instruments: supersaw lead stacks, sidechained pads over four-on-the-floor kick, rolling sub, white-noise risers, pluck arps; vocal: euphoric chopped vocal hook; form: 8-bar build with snare roll into wide drop; production: club-loud, huge stereo drop",
  "lo-fi":      "tempo 70-88 BPM; chords: jazzy ii7-V7-Imaj7 with 9ths, looped Imaj7-vi7; instruments: dusty Rhodes or nylon guitar loop, lazily swung MPC drums, muted upright bass, vinyl crackle, soft foley; vocal: usually none or distant hushed; production: tape saturation, lo-pass warmth, imperfect human timing, small mono-ish image",
  "jazz":       "tempo flexible (ballad 60 / swing 120-180); chords: ii-V-I with alterations b9 #11 13, tritone subs, turnarounds; instruments: piano or guitar comping, walking upright bass, brushed drums, expressive horn lead; vocal: relaxed conversational phrasing behind the beat, scat option; form: head-solos-head; production: live room, natural dynamics",
  "blues":      "tempo 60-110 shuffle; chords: 12-bar I7-IV7-V7 with quick change; instruments: gritty electric guitar with string bends and vibrato, shuffle drums, honky-tonk piano or harmonica; vocal: raspy weathered storytelling, call-and-response with guitar; production: vintage amp breakup, room ambience",
  "classical":  "tempo per movement; harmony: functional tonality, secondary dominants, clear cadences, counterpoint; instruments: strings, woodwinds, horns or solo piano; vocal: none or operatic; form: clear thematic statement and development; production: concert-hall reverb, wide dynamic range pianissimo to fortissimo, no drum kit",
  "cinematic":  "tempo 60-110 building; harmony: minor ostinato over pedal tones, chromatic mediant shifts i-bVI I-bIII for awe; instruments: string ostinato, French horn swells, taiko and low percussion hits, choir pads, soaring legato theme, hybrid pulses; form: slow build to trailer-scale climax; production: huge dynamic range, cinematic width",
  "folk":       "tempo 75-110 BPM; chords: I-IV-V with relative-minor moves, open-string voicings, capo colors; instruments: fingerpicked acoustic guitar, subtle fiddle harmonica or mandolin, soft brushes or none; vocal: intimate close-mic storytelling, natural breaths, simple harmony on chorus; production: warm organic room, minimal processing",
  "country":    "tempo 80-130 BPM; chords: I-IV-V, vi-IV bridge, optional final key change; instruments: twangy Telecaster licks, pedal steel swells, acoustic strum, train-beat drums; vocal: warm narrative drawl, big singalong chorus with harmonies; production: Nashville polish, clear vocal forward",
  "metal":      "tempo 120-200 BPM; chords: drop-tuned power riffs, Phrygian i-bII menace, pedal-point chugs; instruments: quad-tracked palm-muted rhythm guitars, double-kick drums, aggressive bass; vocal: growled or soaring clean, layered screams; form: breakdown before final chorus; production: tight modern wall of sound, clicky kick",
  "funk":       "ERA ANCHOR: default to 1970s funk production; tempo 95-115 BPM; chords: one-chord E9 dominant vamps, short ii-V turnarounds; instruments: syncopated 16th-note scratch guitar, slap-and-pop live bass, tight horn stabs, clavinet, dry punchy kit; vocal: gritty shouts, call-and-response with horns; craft: emphasis on the One, space is the groove; production: dry tight 70s mix",
  "reggae":     "tempo 70-90 BPM; chords: I-IV or i-bVII two-chord vamps; instruments: off-beat skank guitar chops, deep round one-drop bass, bubbling organ, rimshot-heavy drums; vocal: laid-back patois-tinged delivery, harmony refrains; production: dubby spring reverb accents, deep warm low end",
  "ambient":    "tempo none or under 70; harmony: static Lydian/maj7 pads, drones with slow suspensions; instruments: evolving synth pad layers, shimmer reverb tails, field recordings, sparse piano motifs; vocal: none or wordless airy; production: no drums, meditative stillness, very long reverb, gentle stereo drift",
  "city pop":   "ERA ANCHOR: style must literally say 1980s Japanese city pop, analog tape warmth — era words are essential or the model drifts modern; tempo 98-115 BPM; chords: maj7/9 harmony, IVmaj7-iii7-vi9 motion, ii-V into relative keys; instruments: DX7 FM electric piano sparkle, chorused clean strat guitar, slap bass fills, tight gated-reverb snare, horn stabs; vocal: smooth breathy Japanese female or suave male, light doubles; craft: Tokyo night-drive nostalgia, sax or synth solo; production: airy bright top end, glossy 80s sheen; EXCLUDE: modern trap, 808 sub bass, EDM drop, muddy low-mids",
  "mandopop":   "tempo ballad 62-80 / mid 90-110; chords: 4536 piano-ballad family (C-G/B-Am-Em-F-C-Dm-G), final-chorus key lift; instruments: piano-driven with string pads, melodic guitar counter-lines, soft kit entering at chorus; vocal: breathy intimate Mandarin verse rising to soaring belted chorus, tasteful runs; production: lush wide chorus, vocal-forward KTV-ready mix",
  "k-pop":      "tempo 100-128 BPM; chords: bright IV-V-iii-vi loops with section-to-section genre switches; instruments: stacked synth hooks, punchy modern drums, beat-switch rap bridge; vocal: meticulous multi-member-style layering, chant-along post-chorus, killing-part hook; production: ultra-clean modern polish, dramatic drops and risers",
  "bossa nova": "tempo 60-90 BPM; chords: m7/maj7 with chromatic descent (Imaj7-bIIdim-ii7-V7b9); instruments: syncopated nylon-string guitar comping, soft brushed drums, muted upright bass, airy flute or trombone; vocal: cool understated near-spoken delivery; production: intimate small-room warmth, gentle Rio sway",
  "synthwave":  "ERA ANCHOR: style must say 1980s retro-futuristic synthwave, analog synths; tempo 85-118 BPM; chords: minor i-bVI-bIII-bVII loops; instruments: analog arpeggios, gated-reverb snare, neon retro pads, chugging bass sequencer, FM bells; vocal: often instrumental, or reverbed distant vocal; production: VHS warmth, controlled modern low end; EXCLUDE: trap hi-hats, dubstep",
  "orchestral": "tempo per movement; harmony: full functional palette, contrapuntal inner voices, brass chorales, suspensions and resolutions; instruments: full symphony — string runs, horn calls, timpani rolls, harp sweeps, woodwind colors; vocal: none or full choir; production: cathedral-scale reverb, natural concert balance, no electronic elements",
  "trap":       "tempo 130-150 half-time feel; chords: 2-bar dark minor loop i-bVI, eerie bell or detuned piano motif; instruments: hard 808 sub with long glides, triplet hi-hat rolls, sharp snare on 3, sparse atmosphere pads; vocal: melodic autotuned flow or aggressive delivery, layered ad-libs; production: massive clean low end, dark spacious mix",
  "soul":       "ERA ANCHOR: default to late-1960s/70s soul production; tempo 60-75 slow or 100-120 Motown; chords: I-iii-IV-V motion, gospel-tinged passing chords; instruments: warm live rhythm section, Motown bass lines, horn section stabs, tremolo guitar, tambourine on backbeat; vocal: impassioned raspy-to-smooth lead, church-style runs, BGV answers; production: analog tape warmth, live room glue; EXCLUDE: 808 sub bass, EDM elements",
  "gospel":     "tempo 60-75 worship or 100-120 praise; chords: rich gospel harmony — passing diminished chords, 2-5-1 turnarounds, chromatic walk-ups, final key lifts; instruments: Hammond organ with Leslie, grand piano runs, full choir, live drums with dynamic swells; vocal: powerhouse lead with melisma, call-and-response choir; production: live sanctuary energy, wide choir image",
  "disco":      "ERA ANCHOR: style should say late-1970s disco; tempo 110-125 BPM; chords: minor i-IV vamps with extended 7ths/9ths; instruments: four-on-the-floor kick with open hi-hat offbeats, octave bass line, chicken-scratch guitar, lush string section, horn hits; vocal: soaring diva lead, group hooks; production: glossy strings, dancefloor punch; EXCLUDE: modern EDM drops, trap hi-hats",
  "house":      "tempo 120-126 BPM; chords: m7 two-chord vamps, jazzy extensions for deep house; instruments: four-on-the-floor kick, off-beat open hats, warm sub-bass groove, filtered chord stabs, piano riffs (classic house); vocal: soulful chopped phrases or diva hooks; production: hypnotic loop discipline, club-ready low end, long filter builds",
  "punk":       "tempo 160-180+ BPM; chords: three-chord I-IV-V power progressions, fast downstroke eighths; instruments: raw distorted guitars, driving picked bass, fast simple drums with crash-heavy choruses; vocal: shouted urgent lead, gang-vocal shouts; production: raw garage energy, minimal polish, live and loud; EXCLUDE: synths, orchestral elements, polished pop production",
  "indie":      "tempo 95-115 BPM; chords: I-iii-vi-IV dreamy loops, added 9ths, non-obvious voicings; instruments: jangly or shimmering reverb guitars, round bass, understated drums, analog synth pads; vocal: intimate slightly imperfect delivery, hushed doubles; production: character over polish — tape wobble, room tone, tasteful lo-fi edges",
  "latin":      "tempo reggaeton 90-100 / salsa 170-200; rhythm is king: dembow groove (reggaeton) or 2-3 clave with montuno piano (salsa); chords: Andalusian i-bVII-bVI-V, minor two-chord vamps; instruments: congas, timbales, bright horn section, nylon or electric guitar, piano montuno; vocal: rhythmic Spanish delivery, coro answers; production: percussion-forward, hot and upfront",
  "j-pop":      "tempo ballad 70-85 / standard 110-130; chords: royal road IV-V-iii-vi and Komuro vi-IV-V-I progressions, frequent modulation; instruments: bright piano and strings over tight band, energetic clean guitars, colorful synth touches; vocal: clear emotive Japanese lead, harmonized hooks; form: A-melo B-melo sabi build with last-chorus key change; production: dense but clean arrangement, polished sheen",
  "cantopop":   "tempo ballad 65-80 / mid 95-110; chords: 4536 and Canon progressions, final-chorus key lift; instruments: piano-led with lush strings, clean guitar arpeggios, restrained drums entering at chorus; vocal: expressive Cantonese lead — lyrics MUST follow 協音 tone-melody matching; production: HK studio polish, vocal-forward ballad mix",
  "chinese style": "中國風 fusion; tempo ballad 60-80 / mid 90-105; harmony: pentatonic melodies over modern I-vi-IV-V or minor loops, modal colors (gong/yu modes); instruments: erhu lead lines, guzheng arpeggios and glissandi, dizi ornaments, pipa tremolo, blended with modern piano, strings and soft beats; vocal: lyrical Mandarin with classical poetic imagery (ink, moon, plum blossom); production: airy oriental reverb space, delicate dynamics"
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
