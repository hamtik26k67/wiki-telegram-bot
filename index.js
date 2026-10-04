const UA = "WikiTelegramBot/1.0 (Cloudflare Worker)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Одноразовая установка вебхука: https://<worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));
      return new Response("ok");
    }
    return new Response("Wiki bot is running");
  },
};

/* ---------- Telegram helpers ---------- */

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: text.length > 4000 ? text.slice(0, 3990) + "…" : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/* ---------- Хранилище (KV) ---------- */

const getJSON = async (env, key, def) => (await env.DB.get(key, "json")) ?? def;
const putJSON = (env, key, val, opts) => env.DB.put(key, JSON.stringify(val), opts);

const getAdmins = (env) => getJSON(env, "admins", { ids: [], usernames: [] });
const getBans = (env) => getJSON(env, "bans", { ids: [], usernames: [] });
const getLinks = (env) => getJSON(env, "links", []);

const uname = (u) => (u?.username || "").toLowerCase();
const isOwner = (env, user) => uname(user) === env.OWNER_USERNAME.toLowerCase();

async function isAdmin(env, user) {
  if (isOwner(env, user)) return true;
  const a = await getAdmins(env);
  return a.ids.includes(user.id) || (uname(user) && a.usernames.includes(uname(user)));
}

async function isBanned(env, user) {
  if (isOwner(env, user)) return false;
  const b = await getBans(env);
  return b.ids.includes(user.id) || (uname(user) && b.usernames.includes(uname(user)));
}

// "123456" -> {id}, "@name" / "name" -> {username}
function parseTarget(text) {
  const t = text.trim();
  if (/^\d{3,}$/.test(t)) return { id: Number(t) };
  const m = t.replace(/^@/, "");
  if (/^[A-Za-z0-9_]{4,32}$/.test(m)) return { username: m.toLowerCase() };
  return null;
}

const targetLabel = (t) => (t.id ? `ID ${t.id}` : `@${t.username}`);

function addTo(list, t) {
  if (t.id && !list.ids.includes(t.id)) list.ids.push(t.id);
  if (t.username && !list.usernames.includes(t.username)) list.usernames.push(t.username);
}
function removeFrom(list, t) {
  if (t.id) list.ids = list.ids.filter((x) => x !== t.id);
  if (t.username) list.usernames = list.usernames.filter((x) => x !== t.username);
}
const listText = (l) =>
  [...l.ids.map((i) => `• ID ${i}`), ...l.usernames.map((u) => `• @${esc(u)}`)].join("\n") || "— пусто —";

/* ---------- Обработка апдейтов ---------- */

const HELP =
  "👋 <b>Я ищу информацию в Википедии и Fandom</b> и собираю краткий ответ.\n\n" +
  "• Просто напишите вопрос — поищу в Википедии\n" +
  "• <code>/wiki запрос</code> — только Википедия\n" +
  "• <code>/fandom вики запрос</code> — Fandom, например:\n<code>/fandom minecraft creeper</code>\n" +
  "  Русская версия: <code>/fandom genshin-impact/ru Венти</code>\n" +
  "• <code>/setwiki название</code> — вики Fandom по умолчанию (<code>/setwiki off</code> — выключить)";

async function handleUpdate(u, env) {
  if (u.callback_query) return handleCallback(u.callback_query, env);
  const m = u.message;
  if (!m || !m.text || !m.from) return;

  const user = m.from;
  const chatId = m.chat.id;
  const isPrivate = m.chat.type === "private";
  const text = m.text.trim();

  if (await isBanned(env, user)) {
    if (isPrivate) await send(env, chatId, "⛔ Вы заблокированы в этом боте.");
    return;
  }

  const cm = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const cmd = cm ? cm[1].toLowerCase() : null;
  const arg = cm ? (cm[2] || "").trim() : "";

  // Ожидание ввода от админа (после нажатия кнопки в панели)
  if (!cmd && isPrivate) {
    const st = await getJSON(env, `st:${user.id}`, null);
    if (st && (await isAdmin(env, user))) return handleAdminInput(env, user, chatId, st.action, text);
  }

  if (cmd === "start" || cmd === "help") return send(env, chatId, HELP);

  if (cmd === "cancel") {
    await env.DB.delete(`st:${user.id}`);
    return send(env, chatId, "Отменено.");
  }

  if (cmd === "admin") {
    if (!isPrivate) return;
    if (!(await isAdmin(env, user))) return send(env, chatId, "⛔ Нет доступа.");
    return send(env, chatId, "🛠 <b>Админ-панель</b>", { reply_markup: panelMarkup() });
  }

  if (cmd === "setwiki") {
    if (!arg) return send(env, chatId, "Укажите вики: <code>/setwiki minecraft</code> или <code>/setwiki off</code>");
    if (arg.toLowerCase() === "off") {
      await env.DB.delete(`fw:${user.id}`);
      return send(env, chatId, "Fandom по умолчанию выключен.");
    }
    if (!validWiki(arg)) return send(env, chatId, "Неверное название. Пример: <code>minecraft</code> или <code>genshin-impact/ru</code>");
    await env.DB.put(`fw:${user.id}`, arg.toLowerCase());
    return send(env, chatId, `✅ Вики по умолчанию: <b>${esc(arg)}</b>`);
  }

  if (cmd === "fandom") {
    const [wiki, ...rest] = arg.split(/\s+/);
    const q = rest.join(" ");
    if (!wiki || !q || !validWiki(wiki))
      return send(env, chatId, "Формат: <code>/fandom вики запрос</code>\nНапример: <code>/fandom minecraft creeper</code>");
    return answerQuery(env, chatId, q, { wikipedia: false, fandom: wiki.toLowerCase() });
  }

  if (cmd === "wiki") {
    if (!arg) return send(env, chatId, "Формат: <code>/wiki запрос</code>");
    return answerQuery(env, chatId, arg, { wikipedia: true, fandom: null });
  }

  if (cmd) return; // неизвестная команда

  // Обычный текст — только в личке
  if (!isPrivate || !text) return;
  const defWiki = await env.DB.get(`fw:${user.id}`);
  return answerQuery(env, chatId, text, { wikipedia: true, fandom: defWiki });
}

/* ---------- Поиск и генерация ответа ---------- */

const validWiki = (w) => /^[a-z0-9-]+(\/[a-z-]{2,5})?$/i.test(w);

function fandomApi(w) {
  const [name, lang] = w.split("/");
  return `https://${name}.fandom.com${lang ? "/" + lang : ""}/api.php`;
}

async function mwSearch(api, q) {
  try {
    const p = new URLSearchParams({
      action: "query", generator: "search", gsrsearch: q, gsrlimit: "3",
      prop: "extracts|info", exintro: "1", explaintext: "1", exlimit: "3",
      inprop: "url", redirects: "1", format: "json", formatversion: "2",
    });
    const r = await fetch(`${api}?${p}`, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const pages = (j.query?.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0));
    const page = pages.find((x) => x.extract && x.extract.trim().length > 20);
    return page ? { title: page.title, url: page.fullurl, text: page.extract } : null;
  } catch {
    return null;
  }
}

async function searchWikipedia(q) {
  const langs = /[а-яё]/i.test(q) ? ["ru", "en"] : ["en", "ru"];
  for (const lang of langs) {
    const r = await mwSearch(`https://${lang}.wikipedia.org/w/api.php`, q);
    if (r) return { ...r, source: `Википедия (${lang})` };
  }
  return null;
}

const tokens = (s) =>
  (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => (w.length > 5 ? w.slice(0, 5) : w));

// Извлекающее «саммари» без нейросетей: выбираем самые релевантные запросу предложения
function summarize(text, query, maxChars = 900) {
  text = text.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
  const sents = text.split(/(?<=[.!?…])\s+(?=[\p{Lu}\d"«(])/u).filter((s) => s.length > 15);
  if (!sents.length) return text.slice(0, maxChars);

  const qw = new Set(tokens(query));
  const scored = sents.map((s, i) => {
    let hit = 0;
    for (const t of tokens(s)) if (qw.has(t)) hit++;
    return { s, i, score: hit * 2 + (i === 0 ? 3 : 0) + (s.length < 250 ? 0.5 : 0) };
  });

  const picked = [];
  let total = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score)) {
    if (picked.length >= 4) break;
    if (picked.length && total + x.s.length > maxChars) continue;
    picked.push(x);
    total += x.s.length;
  }
  const out = picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
  return out.length > maxChars + 200 ? out.slice(0, maxChars) + "…" : out;
}

async function answerQuery(env, chatId, query, { wikipedia, fandom }) {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  const [wp, fd] = await Promise.all([
    wikipedia ? searchWikipedia(query) : null,
    fandom ? mwSearch(fandomApi(fandom), query).then((r) => r && { ...r, source: `Fandom (${fandom})` }) : null,
  ]);

  const blocks = [wp, fd].filter(Boolean).map(
    (r) =>
      `🔎 <b>${esc(r.title)}</b> · ${esc(r.source)}\n${esc(summarize(r.text, query))}\n🔗 <a href="${esc(r.url)}">Читать полностью</a>`
  );

  if (!blocks.length) {
    return send(env, chatId, "😕 Ничего не нашёл. Попробуйте переформулировать запрос.");
  }

  // Дополнительные ссылки от админов
  const q = query.toLowerCase();
  const links = (await getLinks(env)).filter(
    (l) => !l.keywords?.length || l.keywords.some((k) => q.includes(k))
  );
  if (links.length) {
    blocks.push("📎 <b>Дополнительная информация</b>\n" + links.map((l) => `• <a href="${esc(l.url)}">${esc(l.title)}</a>`).join("\n"));
  }

  return send(env, chatId, blocks.join("\n\n"));
}

/* ---------- Админ-панель ---------- */

function panelMarkup() {
  const b = (t, d) => ({ text: t, callback_data: d });
  return {
    inline_keyboard: [
      [b("➕ Добавить ссылку", "a:addlink"), b("📋 Ссылки", "a:links")],
      [b("🗑 Удалить ссылку", "a:dellink")],
      [b("🚫 Заблокировать", "a:ban"), b("✅ Разблокировать", "a:unban")],
      [b("📋 Список банов", "a:bans")],
      [b("👑 Добавить админа", "a:addadmin"), b("❌ Убрать админа", "a:deladmin")],
      [b("📋 Список админов", "a:admins")],
    ],
  };
}

const PROMPTS = {
  addlink:
    "Отправьте ссылку в формате:\n<code>Название | https://example.com | ключевые слова (необязательно)</code>\n\nЕсли ключевые слова не указаны, ссылка показывается во всех ответах. Иначе — только когда запрос их содержит (через запятую).\n\n/cancel — отмена",
  dellink: "Отправьте номер ссылки для удаления.\n\n/cancel — отмена",
  ban: "Отправьте @юзернейм или Telegram ID для блокировки.\n\n/cancel — отмена",
  unban: "Отправьте @юзернейм или Telegram ID для разблокировки.\n\n/cancel — отмена",
  addadmin: "Отправьте @юзернейм или Telegram ID нового админа.\n\n/cancel — отмена",
  deladmin: "Отправьте @юзернейм или Telegram ID админа, которого нужно убрать.\n\n/cancel — отмена",
};

async function handleCallback(cq, env) {
  const user = cq.from;
  const chatId = cq.message?.chat.id;
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId || !cq.data?.startsWith("a:")) return;
  if (!(await isAdmin(env, user))) return send(env, chatId, "⛔ Нет доступа.");

  const action = cq.data.slice(2);

  if (action === "links") {
    const links = await getLinks(env);
    const t = links.length
      ? links.map((l, i) => `${i + 1}. <a href="${esc(l.url)}">${esc(l.title)}</a>${l.keywords?.length ? " — " + esc(l.keywords.join(", ")) : ""}`).join("\n")
      : "— пусто —";
    return send(env, chatId, `📋 <b>Ссылки</b>\n${t}`, { reply_markup: panelMarkup() });
  }
  if (action === "bans") return send(env, chatId, `🚫 <b>Заблокированы</b>\n${listText(await getBans(env))}`, { reply_markup: panelMarkup() });
  if (action === "admins") {
    return send(env, chatId, `👑 <b>Админы</b>\n• @${esc(env.OWNER_USERNAME)} (владелец)\n${listText(await getAdmins(env))}`, { reply_markup: panelMarkup() });
  }

  if (action === "deladmin" && !isOwner(env, user)) return send(env, chatId, "⛔ Убирать админов может только владелец.");

  if (PROMPTS[action]) {
    await putJSON(env, `st:${user.id}`, { action }, { expirationTtl: 600 });
    if (action === "dellink") {
      const links = await getLinks(env);
      const t = links.length ? links.map((l, i) => `${i + 1}. ${esc(l.title)}`).join("\n") : "— пусто —";
      return send(env, chatId, `${t}\n\n${PROMPTS.dellink}`);
    }
    return send(env, chatId, PROMPTS[action]);
  }
}

async function handleAdminInput(env, user, chatId, action, text) {
  const done = async (msg) => {
    await env.DB.delete(`st:${user.id}`);
    return send(env, chatId, msg, { reply_markup: panelMarkup() });
  };

  if (action === "addlink") {
    const [title, url, kw] = text.split("|").map((s) => s.trim());
    if (!title || !url || !/^https?:\/\/\S+$/i.test(url))
      return send(env, chatId, "Неверный формат. Пример:\n<code>Правила | https://example.com | правила, закон</code>");
    const keywords = (kw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const links = await getLinks(env);
    links.push({ title, url, keywords });
    await putJSON(env, "links", links);
    return done("✅ Ссылка добавлена.");
  }

  if (action === "dellink") {
    const links = await getLinks(env);
    const n = parseInt(text, 10);
    if (!n || n < 1 || n > links.length) return send(env, chatId, "Нет такого номера. Отправьте номер из списка.");
    const [removed] = links.splice(n - 1, 1);
    await putJSON(env, "links", links);
    return done(`🗑 Удалено: ${esc(removed.title)}`);
  }

  const t = parseTarget(text);
  if (!t) return send(env, chatId, "Не понял. Отправьте @юзернейм (от 4 символов) или числовой Telegram ID.");

  const owner = env.OWNER_USERNAME.toLowerCase();

  if (action === "ban") {
    if (t.username === owner) return done("Нельзя заблокировать владельца.");
    const bans = await getBans(env);
    addTo(bans, t);
    await putJSON(env, "bans", bans);
    return done(`🚫 Заблокирован: ${esc(targetLabel(t))}`);
  }
  if (action === "unban") {
    const bans = await getBans(env);
    removeFrom(bans, t);
    await putJSON(env, "bans", bans);
    return done(`✅ Разблокирован: ${esc(targetLabel(t))}`);
  }
  if (action === "addadmin") {
    const admins = await getAdmins(env);
    addTo(admins, t);
    await putJSON(env, "admins", admins);
    return done(`👑 Админ добавлен: ${esc(targetLabel(t))}`);
  }
  if (action === "deladmin") {
    if (!isOwner(env, user)) return done("⛔ Только владелец.");
    if (t.username === owner) return done("Владельца убрать нельзя.");
    const admins = await getAdmins(env);
    removeFrom(admins, t);
    await putJSON(env, "admins", admins);
    return done(`❌ Админ убран: ${esc(targetLabel(t))}`);
  }
}
