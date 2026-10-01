# Mizanora v3 — Setup Guide (keys kahan se lein)
Developer: Muaaz Iqbal. Sab links official sites ke hain; plans/limits badalte rehte hain, signup par dekh lein.

## 1. Zaroori (minimum)
| Cheez | Kahan se | Kaam |
|---|---|---|
| Gemini key | aistudio.google.com → Get API key | chat, vision, STT, expressive voice (free tier) |
| Firebase project | console.firebase.google.com | login (Google), Firestore, service-account JSON |
| GitHub private repo + token | github.com → Settings → Developer settings → Fine-grained token (Contents, Actions, Workflows: Read/Write) | workflows chalana |
| Vercel account | vercel.com → Import repo | web app + webhook |

## 2. Optional (behtar quality)
Groq (console.groq.com, tez + Whisper), OpenRouter (openrouter.ai), Mistral (console.mistral.ai), DeepSeek (platform.deepseek.com), Tavily (tavily.com, search), Brave Search API, Serper (serper.dev), HuggingFace token (huggingface.co/settings/tokens, images).

## 3. Channels
- **WhatsApp Agent:** WhatsApp → Settings → Agents → Create → chat info → API key → `WHATSAPP_AGENT_API_KEY`.
- **Telegram:** Telegram mein @BotFather → /newbot → token → `TELEGRAM_BOT_TOKEN`.
- **WhatsApp Business:** developers.facebook.com → My Apps → Business → WhatsApp → API Setup (Phone number ID, permanent token via System User) → App Settings → Basic → App Secret (ZAROORI v3 mein). Webhook URL aur verify token web app ke Business tab mein milte hain; subscribe: `messages`.

## 4. Deploy (tarteeb)
1. Firebase: Authentication → Google ON; Firestore banayein; `firestore.rules` mein admin email badal kar Publish. Pehli baar `pub/settings` doc (autoApprove=true) Admin tab se Save karein.
2. Bot repo (Mizanora-v3-core) private GitHub par; secret `FIREBASE_SERVICE_ACCOUNT` (Firebase → Project settings → Service accounts → Generate key).
3. Web zip Vercel par; Firebase Authorized domains mein Vercel domain.
4. Actions → **3 - Mizanora Agents (auto)** → Run workflow (ek baar). Iske baad cron har 30 min khud chalta hai.
5. User: Agent tab mein keys + channel, Home → **Agent start karein**. Admin ki manzoori nahi chahiye; 30 min ke andar agent live.

## 5. Control
User: Home → Stop / Run, Settings tab (naam, timezone, voice, gaane ki hadd). Admin: auto-approve ON/OFF, sab agents pause, max agents, Suspend/Unsuspend. Auto-approve OFF ho to user "pending" rehta hai aur admin Approve dabata hai.

## 6. 24/7 aur restart
Workflow har 30 min cron par, 340 min ka shift, concurrency se overlap nahi. Free GitHub minutes kam hain; serious 24/7 ke liye VPS: `npm i && npm start` (pm2/systemd se auto-restart).

## 7. Naye tools
`compose_music` (instrumental MP3, synth-style, vocals nahi), owner ke liye `run_shell`, `run_python`, `browser_task`, `write_file`, `zip_and_send`. Lambi coding: "project banao aur zip bhejo".

## 8. SEO (Google par upar aane ke liye)
Domain khareedein, Search Console mein verify + sitemap, har page ka unique title/description, logo ka alt text, kaam ke Urdu/English articles ("WhatsApp AI agent kaise banayein"), tez loading, backlinks. Top ranking ki guarantee koi nahi de sakta.

## 9. Security
Keys kabhi chat/repo mein na dein. `appSecret` ke baghair business webhook ab reject hota hai. Owner tools poori machine par code chalate hain.

## 10. Hosted agents ki safety
Multi-user mode mein `run_shell`/`run_python` band hain (warna user runner ke secrets parh sakta tha). Sirf aap ka apna bot (workflow 2) host-shell rakhta hai.

## 11. Agar Actions mein workflow nazar hi na aaye (troubleshooting)
1. **Actions tab → left list mein "3 - Mizanora Agents (auto, multi-user)" hai?** Nahi to `.github/workflows/agents.yml` repo mein upload nahi hui (dot-folder zip se upload nahi hota). Repo → Add file → Create new file → naam `.github/workflows/agents.yml` → content paste.
2. Workflow list mein hai lekin koi run nahi → "Run workflow" dabayein (ya web Admin → ⚡ Run now). Naye workflow ka cron kabhi 30+ min late aata hai.
3. Run aaya, "plan" job mein log dekhein: har user ke samne wajah likhi hoti hai (key missing, stop, pause…). Wahi wajah user ke Home par "Agent ki halat" mein bhi dikhti hai.
4. "run" job skip hua → plan ne 0 agents diye (upar wali wajah dekhein).
5. Repo Settings → Actions → General → "Allow all actions" ON; private repo mein free minutes khatam to kuch nahi chalta (Settings → Billing).
6. Purane per-user workflows (`agent-xxxx-whatsapp.yml`) hata dein, warna dohra chalenge.
