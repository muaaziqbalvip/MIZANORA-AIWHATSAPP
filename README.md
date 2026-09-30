# Mizanora — WhatsApp AI Agent
**Developer: Muaaz Iqbal**

Mizanora ek multi-API WhatsApp AI agent hai (WhatsApp ke **official Agent Platform API** par, `WHATSAPP_AGENT_API_KEY` se connect hota hai): persistent memory, voice notes (Urdu/Hindi/English), live web search, image generation, code execution (sirf owner ke liye), aur group admin control. GitHub Actions par 24/7 chalne ke liye design kiya gaya hai (har 5h40m par state save → next shift).

## Features
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
src/voice.js        STT + TTS + ffmpeg (ogg/opus)
src/memory.js       persistent memory
src/tools/          web search, fetch, weather, image, code exec, group admin
scripts/state.js    AES-256-GCM pack/unpack of memory_store
scripts/*.sh        GitHub Actions shift runner + state saver
.github/workflows/  24/7 workflow
```
