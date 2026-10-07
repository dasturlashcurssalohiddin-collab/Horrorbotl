// Horror Film Bot - Vercel serverless function (Node 18+, qo'shimcha kutubxona kerak emas)
// Muhit o'zgaruvchilari (Vercel > Settings > Environment Variables):
//   BOT_TOKEN  - BotFather bergan token
//   YT_KEY     - (ixtiyoriy) YouTube Data API v3 kaliti
//   ADMIN_CHAT_ID - (ixtiyoriy) faqat shu chat ishlatsin

const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_URL_FILE = 20 * 1024 * 1024; // Telegram URL orqali yuborish limiti (20 MB)

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Xatolarni tuzatish (fuzzy match) ----------
const norm = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё ]/gi, " ").replace(/\s+/g, " ").trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(query, title) {
  const q = norm(query), t = norm(title);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  const whole = 1 - lev(q, t) / Math.max(q.length, t.length);
  // so'zma-so'z solishtirish
  const qw = q.split(" "), tw = t.split(" ");
  let sum = 0;
  for (const w of qw) {
    sum += Math.max(...tw.map((x) => 1 - lev(w, x) / Math.max(w.length, x.length)));
  }
  return Math.max(whole, sum / qw.length);
}

// ---------- Internet Archive qidiruvi ----------
async function archiveSearch(q) {
  const base = "https://archive.org/advancedsearch.php";
  const common = "&fl[]=identifier&fl[]=title&fl[]=downloads&rows=150&output=json";
  const queries = [
    `mediatype:movies AND subject:horror AND title:(${q.split(" ").map((w) => w + "*").join(" ")})`,
    `mediatype:movies AND subject:horror AND collection:feature_films&sort[]=downloads+desc`,
  ];
  const results = new Map();
  for (const query of queries) {
    try {
      const url = `${base}?q=${encodeURIComponent(query.split("&sort")[0])}${common}` +
        (query.includes("&sort") ? "&sort[]=downloads+desc" : "");
      const j = await (await fetch(url)).json();
      for (const d of j.response?.docs || []) results.set(d.identifier, d);
    } catch (e) {}
  }
  return [...results.values()]
    .map((d) => ({ ...d, score: similarity(q, d.title || "") }))
    .filter((d) => d.score > 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ---------- YouTube (faqat havola, Creative Commons) ----------
async function youtubeSearch(q) {
  if (!process.env.YT_KEY) return [];
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3` +
      `&videoLicense=creativeCommon&videoDuration=long&q=${encodeURIComponent(q + " horror full movie")}` +
      `&key=${process.env.YT_KEY}`;
    const j = await (await fetch(url)).json();
    return (j.items || []).map((i) => ({
      title: i.snippet.title,
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
    }));
  } catch (e) { return []; }
}

// ---------- Handlerlar ----------
async function handleMessage(msg) {
  const chat = msg.chat.id;
  if (process.env.ADMIN_CHAT_ID && String(chat) !== process.env.ADMIN_CHAT_ID) return;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    return tg("sendMessage", {
      chat_id: chat,
      text: "🎃 Horror film nomini kiriting:",
    });
  }
  if (!text) return;

  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  const [films, yt] = await Promise.all([archiveSearch(text), youtubeSearch(text)]);

  if (!films.length && !yt.length) {
    return tg("sendMessage", { chat_id: chat, text: `😕 "${text}" bo'yicha hech narsa topilmadi. Nomini boshqacha yozib ko'ring.` });
  }

  if (films.length) {
    await tg("sendMessage", {
      chat_id: chat,
      text: `🎬 "${text}" uchun eng yaqin filmlar. Birini tanlang:`,
      reply_markup: {
        inline_keyboard: films.map((f) => [
          { text: `${f.title.slice(0, 55)} (${Math.round(f.score * 100)}%)`, callback_data: `f:${f.identifier}`.slice(0, 64) },
        ]),
      },
    });
  }
  if (yt.length) {
    await tg("sendMessage", {
      chat_id: chat,
      text: "▶️ YouTube (ochiq litsenziya):\n" + yt.map((v) => `• ${v.title}\n${v.url}`).join("\n\n"),
      disable_web_page_preview: true,
    });
  }
}

async function handleCallback(cb) {
  const chat = cb.message.chat.id;
  const id = (cb.data || "").slice(2);
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  await tg("sendMessage", { chat_id: chat, text: "⏳ Film tayyorlanmoqda..." });

  const meta = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`)).json();
  const mp4s = (meta.files || [])
    .filter((f) => /\.mp4$/i.test(f.name) && f.size)
    .sort((a, b) => Number(a.size) - Number(b.size));
  if (!mp4s.length) {
    return tg("sendMessage", { chat_id: chat, text: `Video fayl topilmadi.\nhttps://archive.org/details/${id}` });
  }
  const small = mp4s.find((f) => Number(f.size) <= MAX_URL_FILE);
  const best = mp4s[mp4s.length - 1];
  const direct = (f) => `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`;

  if (small) {
    const r = await tg("sendVideo", {
      chat_id: chat, video: direct(small), supports_streaming: true,
      caption: meta.metadata?.title || id,
    });
    if (r.ok) return;
  }
  // Film Telegram limitidan katta: to'g'ridan-to'g'ri yuklab olish havolasi
  const mb = Math.round(Number(best.size) / 1048576);
  await tg("sendMessage", {
    chat_id: chat,
    text: `📥 ${meta.metadata?.title || id}\nFilm hajmi ~${mb} MB (Telegram botlari URL orqali 20 MB gacha yuboradi).\nTo'g'ridan-to'g'ri yuklab olish:\n${direct(best)}`,
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      const u = req.body || {};
      if (u.message) await handleMessage(u.message);
      else if (u.callback_query) await handleCallback(u.callback_query);
    }
  } catch (e) {
    console.error(e);
  }
  res.status(200).send("ok");
};

module.exports.config = { maxDuration: 30 };
