// Emotion ("motion") layer for voice replies: the model tags its reply with a mood, we translate it into
// speaking rate / pitch / volume (edge-tts) and a natural-language style prompt (Gemini TTS).
export const MOODS = {
  neutral: { rate: '+0%',  pitch: '+0Hz',  volume: '+0%',  style: 'in a natural, clear, friendly voice' },
  happy:   { rate: '+6%',  pitch: '+4Hz',  volume: '+4%',  style: 'warmly and cheerfully, with a smile in the voice' },
  excited: { rate: '+12%', pitch: '+7Hz',  volume: '+8%',  style: 'with energy and excitement' },
  calm:    { rate: '-8%',  pitch: '-2Hz',  volume: '-4%',  style: 'slowly, calmly and soothingly' },
  serious: { rate: '-4%',  pitch: '-4Hz',  volume: '+0%',  style: 'in a serious, steady, professional tone' },
  sad:     { rate: '-12%', pitch: '-5Hz',  volume: '-8%',  style: 'softly and sadly, with empathy' },
  caring:  { rate: '-5%',  pitch: '+1Hz',  volume: '-2%',  style: 'gently and caringly, like comforting a friend' },
  apology: { rate: '-6%',  pitch: '-1Hz',  volume: '-3%',  style: 'sincerely apologetic and humble' },
};

const TAG = /^\s*(?:\[|<<|\()\s*(?:mood|emotion|tone)\s*[:=]\s*([a-z]+)\s*(?:\]|>>|\))\s*/i;

/** "[mood: happy] Salam!" → { mood: 'happy', text: 'Salam!' }  (unknown/absent tag → mood '') */
export function extractMood(text) {
  const t = String(text || '');
  const m = t.match(TAG);
  if (!m) return { text: t.trim(), mood: '' };
  const mood = m[1].toLowerCase();
  return { text: t.slice(m[0].length).trim(), mood: MOODS[mood] ? mood : '' };
}

/** Cheap fallback when the model forgot the tag. */
export function inferMood(text) {
  const t = String(text || '').toLowerCase();
  if (/(maazrat|maafi|sorry|معذرت|معاف|क्षमा)/.test(t)) return 'apology';
  if (/(mubarak|congrat|shabash|zabardast|wah wah|مبارک|بہت خوب|बधाई)/.test(t) || (t.match(/!/g) || []).length >= 2) return 'excited';
  if (/(afsos|dukh|sad to|takleef|pareshan|افسوس|دکھ|پریشان)/.test(t)) return 'caring';
  if (/(khatra|warning|zaroori|important|dhyan|خبردار|اہم)/.test(t)) return 'serious';
  if (/(shukriya|thanks|welcome|khush|شکریہ|خوش)/.test(t)) return 'happy';
  return 'neutral';
}

export const moodParams = (mood) => MOODS[mood] || MOODS.neutral;
