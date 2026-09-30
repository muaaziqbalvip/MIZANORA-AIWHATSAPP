# Mizanora — WhatsApp AI Agent
**Developer: Muaaz Iqbal**

Mizanora ek multi-API WhatsApp AI agent hai (WhatsApp ke **official Agent Platform API** par, `WHATSAPP_AGENT_API_KEY` se connect hota hai): persistent memory, voice notes (Urdu/Hindi/English), live web search, image generation, code execution (sirf owner ke liye), aur group admin control. GitHub Actions par 24/7 chalne ke liye design kiya gaya hai (har 5h40m par state save → next shift).


# ⚡ v2 — kya naya hai (upgrade)

| Cheez | Ab kya hota hai |
|---|---|
| 🎙️ **Voice (behtar + emotion)** | Jawab ka *mood* (happy / excited / calm / serious / caring / sad / apology) model khud chunta hai aur awaaz ki raftaar, pitch, volume us hisaab se badalti hai. Engine ladder: **Gemini TTS** (expressive, natural Urdu) → **edge-tts** → OpenAI. Roman Urdu jawab bolne se pehle khud **Urdu script** mein badal jata hai (warna English accent mein parhta). ffmpeg se khamoshi trim, loudness barabar, `/speed`, `/voice male|female`. Incoming voice note bhi pehle saaf (noise/rumble) karke STT ko jata hai. Lambe jawab: voice = shuruaat, text = poora. |
| 🔎 **Naya search system** | Ek saath kai engines (Gemini Google-grounded + Bing + DuckDuckGo + Tavily/Brave/Serper jo keys hon) → duplicates hata kar **reciprocal-rank fusion** se ranking → 5-10 min cache. `recency=day/week/month`. Alag tools: `news_search` (Google News + Bing News, publisher + kitni purani), `wikipedia`, `deep_research` (sawal tor kar 3-6 searches → behtareen pages parhta → **cited brief**), `currency_convert`, `crypto_price`. Page reader ab nav/footer hata kar article deta hai aur PDF bhi parhta hai. |
| 🌐 **Browser agent** | Asli headless Chromium: `browse`, `screenshot`, aur **`browser_task`** — maqsad do ("daraz par sab se sasta 128GB phone dhundo"), woh khud search/click/type/scroll/read karta hai aur natija + screenshot bhejta hai. Sirf **owner** ke liye. Safety: passwords/OTP/card kabhi type nahi karta; buy/pay/post/delete se pehle aap se poochta hai; localhost/private network block; page ka text sirf *data* hai (prompt-injection se bachao). |
| ⏰ **Automation** | `schedule_task`: "roz subah 8 baje weather + top news voice mein bhejo", "har Jumma dollar rate check karo" — bot us waqt khud apne tools chala kar natija bhejta hai. `set_reminder` ab repeat aur voice support karta hai. `/tasks`, `/cancel <id>`. Sab memory mein hain, har shift ke baad wapas start. |
| 🧰 **WhatsApp agent features** | Naye commands (`/search /research /news /browse /shot /task /tasks /cancel /speed /export /ping`), location message samajhna, lambe jawab ke liye document (12 msg/min ki hadd bachane ko), lambe kaam par 2-3 progress messages, file tools (`write_file`, `zip_and_send`). |

**Mark-LIV se kya liya:** browser_control ka idea (numbered elements + normalize URL "instagram → instagram.com"), web_search ki Gemini ladder, edge-tts voices, emotion/viseme ka concept (awaaz ke mood ke roop mein). **Kya nahi liya (WhatsApp/GitHub runner par chal hi nahi sakta):** pyautogui/desktop control, wake word, microphone/speaker, avatar/UI, game updater.

**Naye secrets/variables (sab optional):** `TTS_ORDER`, `TTS_GEMINI_MODELS`, `BROWSER_ENABLED=false` (agar browser band karna ho), `TAVILY_API_KEY`/`BRAVE_API_KEY`/`SERPER_API_KEY` (search aur behtar).

### v2 ki sachchai (zaroor parhein)
1. **Live test nahi hua.** Mere sandbox mein internet nahi tha: 55 offline checks pass hain (mock Meta API + mock AI + fake browser page), lekin asli Gemini TTS, asli Chromium aur asli Bing/Google News pages par pehli run mein chhoti adjustments lag sakti hain. Har naya hissa fail hone par purane raste par gir jata hai (TTS: Gemini→edge→OpenAI; search: engine fail ho to baaqi chalte hain; browser: saaf error message).
2. **Gemini TTS ke model naam preview hain** (`gemini-2.5-flash-preview-tts`) aur badal sakte hain; 404 par bot khud agla rung try karta hai. `TTS_GEMINI_MODELS` se badlein. Free quota kam hota hai — 429 par 5 min ke liye edge-tts par chala jata hai.
3. **GitHub Actions ke IPs par kuch sites captcha/block dengi** (Google, Cloudflare wali). Bing/DuckDuckGo aam taur par chalti hain. Login-wali sites ke liye bot password type nahi karta (jaan boojh kar).
4. **Browser cookies** `memory_store/browser_state.json` mein save hoti hain (AES se encrypted state ke andar) taake consent/preferences yaad rahein. Agar nahi chahiye to file delete karein ya `BROWSER_ENABLED=false`.
5. `browser_task` owner ko poori web access deta hai — API key kisi ko na dein (pehle wali warning barqarar hai).

## Features (v1 base)
| Feature | Kaise kaam karta hai |
|---|---|
| Multi-API | Groq, Gemini, OpenRouter, Cerebras, Mistral, DeepSeek, Together, OpenAI, Ollama + koi bhi OpenAI-compatible (`CUSTOM_*`). Har provider ki **kai keys** (`GROQ_API_KEYS=k1,k2,k3`) — rate-limit par key rotate, provider down ho to agla provider |
| Memory | `memory_store/bot_memory.json`: user profiles/facts, chat history (auto-summary), reminders, logs. Har 30s autosave, SIGTERM par flush |
| 24/7 | 340 min baad clean shutdown → memory + WhatsApp session **AES-256-GCM encrypted** ho kar `state` branch mein → naya shift auto-start |
| Voice | Voice note → Groq Whisper (fallback OpenAI/Gemini) → jawab → edge-tts (Urdu `ur-PK-UzmaNeural`) → native WhatsApp voice note (`ptt`) |
| Search | Tavily / Brave / Serper (agar key ho) warna DuckDuckGo; `fetch_url` se poora page (SSRF-protected) |
| Images | Pollinations → HuggingFace FLUX → Together → OpenAI (automatic fallback). Aane wali images ko vision model samajhta hai |
| Files | PDF / txt / csv / json / code files parh kar sawal ka jawab; video ki audio transcribe |
| Groups | sirf *Baileys* mode mein (optional, unofficial): add/remove, promote/demote, invite link, pin. Official Agent API mein groups nahi hain |
| Code | `run_python`, `run_shell` — **sirf OWNER**; child process ko API keys nahi milti |


## Commands
`/help` `/reset` `/voice on|off|auto` `/memory` `/whoami` `/status` (owner)

## Setup — official WhatsApp Agent API (sab kuch GitHub par)

Is mode mein **pairing / QR / phone linking nahi**. Bas agent ki API key chahiye.

**1. Agent banayein (aap ne bana liya):** WhatsApp → Settings → Agents → Create an agent (naam: MIZANORA).
Agent ki chat mein WhatsApp ka message aata hai *"use this API key to connect it to WhatsApp"* → **View API key** dabayein
(ya chat → Chat info → API key) aur key copy karein. Yeh key bot ka poora control deti hai — kisi ko na dein, chat mein paste na karein.

**2. Private repo banayein** aur is zip ki saari files upload karein. `.github/workflows/` folder upload na ho to
Add file → *Create new file* mein `.github/workflows/mizanora.yml` naam likh kar content paste karein.

**3. Secrets daalein** (repo → Settings → Secrets and variables → Actions → New repository secret):

| Secret | Kya daalein |
|---|---|
| `WHATSAPP_AGENT_API_KEY` | woh agent API key (step 1) |
| `STATE_PASSPHRASE` | apni banayi hui lambi passphrase (12+ chars) — memory isi se encrypt hoti hai |
| `GEMINI_API_KEYS` | Gemini key(s), comma se alag: `key1,key2` |
| `GROQ_API_KEYS` | (optional) backup AI + Whisper STT |
| baaqi (optional) | `OPENROUTER_API_KEYS`, `MISTRAL_API_KEYS`, `OPENAI_API_KEYS`, `TAVILY_API_KEY`, `HF_TOKEN` … |

**4. Start:** Actions tab → **2 - Mizanora 24/7** → *Run workflow*. Log mein dikhega:
`WhatsApp Agent Platform: authenticated; long polling started`.

**5. Test:** MIZANORA agent ki WhatsApp chat mein "salam" likhein. Voice note, photo, PDF bhi bhej sakte hain.

Workflow har ~5h40m par memory save karke agla shift khud shuru karta hai. `OWNER_NUMBERS` is mode mein zaroori nahi
(agent ka creator hi owner hai).

**Agar `invalid_auth` / key rejected aaye:** WhatsApp dobara install karne se key regenerate ho jati hai — nayi key copy karke secret update karein.
**Agar `poll_conflict` (409) aaye:** ek key par sirf ek poller chal sakta hai — koi doosra client/script band karein.

### Official Agent API ki hadein (Meta ki beta)
- Sirf agent ka **creator** (aap) us se baat kar sakta hai; groups aur doosre log nahi.
- 12 messages/minute bhej sakte hain (lambi jawab auto-split hote hain), isliye bot chhote jawab deta hai.
- Agent chats **end-to-end encrypted nahi** hain (Meta ke zariye guzarti hain).
- Buttons/reactions nahi; voice reply *audio message* ki tarah jata hai.
- Groups / kai users chahiye to optional Baileys mode hai (`WA_MODE=baileys`, workflow "Optional - Pair via Baileys") — lekin woh unofficial hai aur ban ka risk rakhta hai.

## Gemini models (Mark-LIV wale)
Mark-LIV ki `core/gemini.py` aur `actions/web_search.py` se woh hi ladders li gayi hain (upar se neeche try hoti hain; 429/404/5xx par agla):
- **Chat / vision / image samajhna:** `gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-flash-latest` → `gemini-flash-lite-latest`
- **Live web search (google_search grounding):** `gemini-2.5-flash` → `gemini-flash-latest` → `gemini-2.5-flash-lite`
- **Voice note → text:** isi ladder se Gemini, phir Groq Whisper / OpenAI
- **TTS:** edge-tts (Mark-LIV ka `edgetts` engine), Urdu voice `ur-PK-UzmaNeural`

*Do baaton ka dhyan:* (1) Google ne `gemini-2.5-flash` / `2.5-flash-lite` ko deprecate kar diya hai — naye API keys par ye 404 de sakte hain. Is liye ladder ke aakhir mein `gemini-3.5-flash` aur `gemini-3.1-flash-lite` bhi hain; bot retired models khud skip kar deta hai. Variable `GEMINI_MODEL` (comma-separated) se aap ladder badal sakte hain. (2) Mark-LIV ka `gemini-3.1-flash-live-preview` live *awaaz-streaming* model hai (microphone/speaker session). WhatsApp message-based hai, is liye uski jagah Gemini STT + edge-tts voice note use hota hai.

## Zaroori sachchaiyan (please parh lein)
1. **Agent Platform Meta ki beta feature hai** — API badal sakti hai. Meta ka developer-manual PDF mujhe khulne nahi diya; maine protocol public open-source clients (Hermes plugin, `whagent`) se liya. Text, read receipts, media download ka format wahan se confirm hai; media *upload ke baad message payload* mein `id` key ka naam Cloud API ki tarah maani gayi hai (agar Meta `media_id` mangta hai to code khud dobara try karta hai). Baileys (optional mode) unofficial hai aur ban ka risk rakhta hai.
2. **GitHub Actions par 24/7 bot chalana risky hai.** Private repo mein free plan sirf ~2000 min/month deta hai (24/7 ke liye ~43,000 min chahiye). Public repo mein minutes free hain lekin logs public hote hain aur GitHub ki Terms of Service is tarah ke long-running bot use ko allow na bhi kar sakti hain — apni zimmedari par karein. Agar kabhi Actions se hatna ho to wahi code kisi VPS par `npm start` se chalta hai.
3. **Live WhatsApp par test nahi ho saka** (mere sandbox mein internet nahi tha). Offline self-test (32 checks: mock AI server **aur mock Meta Agent API** — polling, creator check, image download/upload, dedupe, rate limits, failover, model ladder, permissions, encrypted state) pass hai, lekin pehli real run mein Baileys ki version-specific cheezein (pairing, group IDs/LID, pin) dekhni pad sakti hain. Agar group mein aap owner recognize nahi hote to `/whoami` bhejein aur dikhne wali ID `OWNER_LIDS` mein daalein.
4. **Model names badalte rehte hain.** Agar koi provider 404 de to `GROQ_MODEL`, `GEMINI_MODEL` wagaira env se update karein. Chalne ke baad `package.json` mein Baileys ka version pin kar dein.
5. Owner tools (`run_python`, `run_shell`) poori machine par code chalate hain. Agent mode mein creator (aap) hi owner hai, is liye agent ki API key kisi ko na dein. Baileys mode mein `OWNER_NUMBERS` sirf apna number rakhein.

## Structure
```
src/index.js        entry, graceful shutdown, reminder scheduler
src/agentplatform.js  OFFICIAL WhatsApp Agent Platform transport (long-poll, media, receipts)
src/whatsapp.js     optional Baileys gateway (groups; unofficial)
src/brain.js        agent loop (tools), vision, history compaction
src/llm.js          multi-provider router (key rotation + failover)
src/voice.js        STT (cleaned audio) + expressive TTS ladder + ffmpeg polish
src/emotion.js      mood tags → voice rate/pitch/style
src/commands.js     slash commands (shared by both transports)
src/scheduler.js    recurring-time math (bot timezone)
src/jobs.js         runs due reminders + AI agent jobs
src/vision.js       image understanding (shared)
src/tools/search.js multi-engine search, news, wiki, deep_research
src/tools/browser.js headless-browser agent (Playwright)
src/tools/finance.js currency + crypto
src/memory.js       persistent memory
src/tools/          web search, fetch, weather, image, code exec, group admin
scripts/state.js    AES-256-GCM pack/unpack of memory_store
scripts/*.sh        GitHub Actions shift runner + state saver
.github/workflows/  24/7 workflow
```
