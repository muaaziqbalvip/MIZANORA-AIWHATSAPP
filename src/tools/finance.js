// Keyless money tools: currency conversion (open.er-api.com) and crypto prices (CoinGecko).
const UA = 'Mizanora/2 (+whatsapp agent)';
const COINS = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', bnb: 'binancecoin', xrp: 'ripple', doge: 'dogecoin', ada: 'cardano', usdt: 'tether', usdc: 'usd-coin', ton: 'the-open-network', trx: 'tron', dot: 'polkadot', ltc: 'litecoin', matic: 'matic-network', shib: 'shiba-inu' };

export async function convertCurrency({ amount = 1, from, to }) {
  const f = String(from || '').toUpperCase().trim(); const t = String(to || '').toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(f) || !/^[A-Z]{3}$/.test(t)) throw new Error('use 3-letter currency codes, e.g. USD, PKR, EUR');
  const r = await fetch(`https://open.er-api.com/v6/latest/${f}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`rates service ${r.status}`);
  const j = await r.json();
  const rate = j?.rates?.[t];
  if (!rate) throw new Error(`no rate for ${f}→${t}`);
  const amt = Number(amount) || 1;
  return `${amt} ${f} = ${(amt * rate).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${t}  (1 ${f} = ${rate} ${t}; rates updated ${String(j.time_last_update_utc || '').slice(0, 16)} UTC — mid-market, banks/exchanges differ)`;
}

export async function cryptoPrice({ coin, vs = 'usd,pkr' }) {
  const q = String(coin || '').toLowerCase().trim();
  if (!q) throw new Error('coin is required');
  let id = COINS[q] || q.replace(/\s+/g, '-');
  const vsList = String(vs).toLowerCase().replace(/[^a-z,]/g, '').slice(0, 40) || 'usd';
  const get = async (i) => { const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(i)}&vs_currencies=${vsList}&include_24hr_change=true`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`coingecko ${r.status}`); return r.json(); };
  let j = await get(id);
  if (!j[id]) {
    const s = await (await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).json();
    id = s?.coins?.[0]?.id; if (!id) throw new Error(`coin "${coin}" not found`);
    j = await get(id);
  }
  const d = j[id] || {};
  return `${id}: ` + vsList.split(',').filter((c) => d[c] !== undefined).map((c) => `${d[c].toLocaleString('en-US', { maximumFractionDigits: 6 })} ${c.toUpperCase()}${d[`${c}_24h_change`] !== undefined ? ` (${d[`${c}_24h_change`].toFixed(2)}% 24h)` : ''}`).join(' · ');
}
