// LockedLife — Noctis AI: Telegram‑бот (Supabase Edge Function `bot`).
//
// Что делает: принимает текст и голосовые сообщения → (голос → Groq Whisper → текст) →
// модель Groq превращает текст в СПИСОК ДЕЙСТВИЙ по строгой схеме → код проверяет каждое действие
// (даты, суммы, существование балансов и категорий) → простые записи сохраняет сразу (с кнопкой «Отменить»),
// финансовые и массовые — только после кнопки «Да, сохранить».
// Модель НЕ имеет доступа к базе: она только предлагает действия из фиксированного списка.
//
// Секреты (Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_TELEGRAM_IDS, GROQ_API_KEY
//   необязательно: BOT_TIMEZONE (по умолчанию Europe/Berlin), GROQ_MODEL, GROQ_STT_MODEL
// В настройках функции выключите «Enforce JWT verification» — Telegram не передаёт ключ Supabase.
//
// Маршруты:
//   POST /                      — webhook Telegram (проверяется заголовок X-Telegram-Bot-Api-Secret-Token)
//   GET  /setup?key=СЕКРЕТ      — один раз: подключить webhook и меню команд
//   GET  /health                — проверка настроек (без секретов)

import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ALLOWED_IDS = (Deno.env.get("ALLOWED_TELEGRAM_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b";
const STT_MODEL = Deno.env.get("GROQ_STT_MODEL") ?? "whisper-large-v3-turbo";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Europe/Berlin";
const MAX_VOICE_SEC = 300;
const MAX_TEXT = 2000;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

/* ======================= Telegram ======================= */
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error("telegram", method, j.description);
  return j;
}
const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const send = (chat_id: number, text: string, buttons?: { text: string; data: string }[][]) =>
  tg("sendMessage", {
    chat_id, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
  });

/* ======================= Даты (часовой пояс пользователя) ======================= */
const ymdIn = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hmIn = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const WD_RU = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function parseYmd(s: string) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addDays(s: string, n: number) { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const wdIdx = (s: string) => (parseYmd(s).getUTCDay() + 6) % 7; // 0 = Пн
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseYmd(s).getTime()) && parseYmd(s).toISOString().slice(0, 10) === s;
const isHm = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
function human(s: string, today: string) {
  if (s === today) return "сегодня";
  if (s === addDays(today, 1)) return "завтра";
  if (s === addDays(today, -1)) return "вчера";
  const d = parseYmd(s); return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`;
}

/* ======================= Деньги ======================= */
const CUR_SIGN: Record<string, string> = { EUR: "€", USD: "$", UAH: "₴" };
function parseMoney(str: unknown): number | null {
  const s = String(str ?? "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const v = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return v > 0 ? v : null;
}
const NF = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (minor: number, cur: string) => `${minor < 0 ? "−" : ""}${NF.format(Math.abs(minor) / 100)} ${CUR_SIGN[cur] ?? cur}`;

/* ======================= Данные пользователя ======================= */
type Rec = { kind: string; id: string; data: any };
async function loadRecords(uid: number, kinds: string[]): Promise<Rec[]> {
  const { data, error } = await db.from("records").select("kind,id,data")
    .eq("user_id", uid).in("kind", kinds).eq("deleted", false).limit(20000);
  if (error) throw new Error("db: " + error.message);
  return (data ?? []) as Rec[];
}
async function pushRecords(uid: number, recs: Rec[], deleted = false) {
  const now = Date.now();
  const changes = recs.map((r) => ({ kind: r.kind, id: r.id, updatedAt: now, deleted, data: deleted ? null : { ...r.data, updatedAt: now } }));
  const { error } = await db.rpc("sync_push", { p_user: uid, p_changes: changes });
  if (error) throw new Error("db: " + error.message);
}
type Ctx = {
  uid: number; today: string; now: string;
  accounts: any[]; categories: any[]; txns: any[]; tasks: any[]; rules: any[]; mainCur: string;
};
async function loadCtx(uid: number): Promise<Ctx> {
  const recs = await loadRecords(uid, ["account", "category", "txn", "task", "rule", "settings"]);
  const by = (k: string) => recs.filter((r) => r.kind === k).map((r) => ({ ...r.data, id: r.id }));
  const settings = recs.find((r) => r.kind === "settings");
  const d = new Date();
  return {
    uid, today: ymdIn(d), now: hmIn(d),
    accounts: by("account").filter((a) => !a.archived),
    categories: by("category").filter((c) => !c.archived),
    txns: by("txn"), tasks: by("task"), rules: by("rule"),
    mainCur: settings?.data?.value?.mainCurrency ?? "EUR",
  };
}
function balances(ctx: Ctx) {
  const b: Record<string, number> = {};
  const all = ctx.accounts; for (const a of all) b[a.id] = a.initial || 0;
  for (const t of ctx.txns) {
    if (t.type === "expense") b[t.accountId] = (b[t.accountId] || 0) - t.amount;
    else if (t.type === "income") b[t.accountId] = (b[t.accountId] || 0) + t.amount;
    else if (t.type === "transfer") { b[t.accountId] = (b[t.accountId] || 0) - t.amount; b[t.toAccountId] = (b[t.toAccountId] || 0) + (t.toAmount || t.amount); }
  }
  return b;
}

/* ======================= Модель (Groq) ======================= */
const ACTION_TYPES = ["create_task", "create_rule", "create_goal", "create_idea", "add_expense", "add_income", "transfer",
  "query_spending", "query_income", "query_tasks", "query_balance"] as const;
const S_STR = { type: ["string", "null"] };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["actions", "clarification", "language"],
  properties: {
    language: { type: "string", enum: ["ru", "uk", "en"] },
    clarification: S_STR,
    actions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["type", "title", "body", "tags", "date", "time", "days", "start_date", "end_date", "month", "target",
          "amount", "currency", "account", "to_account", "to_amount", "category", "note", "period_from", "period_to"],
        properties: {
          type: { type: "string", enum: ACTION_TYPES },
          title: S_STR, body: S_STR, tags: { type: "array", items: { type: "string" } },
          date: S_STR, time: S_STR, days: { type: "array", items: { type: "integer" } },
          start_date: S_STR, end_date: S_STR, month: S_STR, target: { type: ["integer", "null"] },
          amount: S_STR, currency: S_STR, account: S_STR, to_account: S_STR, to_amount: S_STR,
          category: S_STR, note: S_STR, period_from: S_STR, period_to: S_STR,
        },
      },
    },
  },
};
function systemPrompt(ctx: Ctx) {
  const accs = ctx.accounts.map((a) => `${a.name} (${a.currency})`).join(", ") || "нет";
  const exp = ctx.categories.filter((c) => c.kind === "expense").map((c) => c.name).join(", ");
  const inc = ctx.categories.filter((c) => c.kind === "income").map((c) => c.name).join(", ");
  return `Ты — Noctis, ассистент приложения LockedLife. Преобразуй сообщение пользователя в JSON со списком действий.
Сегодня ${ctx.today} (${WD_RU[wdIdx(ctx.today)]}), сейчас ${ctx.now}, часовой пояс ${TZ}.
Балансы пользователя: ${accs}. Основная валюта: ${ctx.mainCur}.
Категории расходов: ${exp}. Категории доходов: ${inc}.

Правила:
- Одно сообщение может содержать несколько команд — верни несколько действий в том же порядке.
- Даты строго YYYY-MM-DD, время HH:MM (24 часа). «завтра», «в пятницу», «через 2 дня» вычисляй от сегодняшней даты.
- НИКОГДА не выдумывай суммы, балансы, категории и задачи. account/to_account/category — только точные названия из списков выше, иначе null.
- create_task: разовое дело. title — кратко, с заглавной буквы. date — если не сказано, null. time — если сказано.
- create_rule: повторяющееся дело («каждый день», «по будням», «по понедельникам»). days: 0=Пн … 6=Вс (каждый день = [0,1,2,3,4,5,6]). start_date — если не сказано, null. end_date — если сказано («до конца месяца»), иначе null.
- create_goal: цель на месяц («цель на ноябрь — …»). month YYYY-MM (если месяц не назван — текущий). target — число, если есть («30 откликов» → 30), title без числа не сокращай.
- create_idea: «запиши идею», «идея: …», «мысль». title — суть до 60 символов, body — подробности или null, tags — 1–2 коротких тега на языке пользователя.
- add_expense / add_income: amount — число как сказано («15», «12.50»), currency — EUR/USD/UAH или null, account, category, note — магазин или описание, date — если не сказано, null.
- transfer: amount, account (откуда), to_account (куда), to_amount — только если названа сумма зачисления.
- query_spending / query_income: period_from, period_to включительно. «за последнюю неделю» = 7 дней по сегодня включительно, «в этом месяце» = с 1-го числа по сегодня. category / account — если названы.
- query_tasks: date (по умолчанию сегодня). query_balance: account или null (все).
- Неиспользуемые поля = null, tags и days = [].
- Если это не команда (приветствие, вопрос «что ты умеешь») — actions = [] и clarification = короткий ответ.
- Если команда неоднозначна и ты не можешь заполнить обязательное (например, неясно, что именно сделать) — actions = [] и clarification = уточняющий вопрос.
- language — язык сообщения пользователя (ru, uk или en); clarification пиши на этом языке.`;
}
class GroqLimit extends Error {}
async function groqChat(ctx: Ctx, text: string): Promise<any> {
  const body = (strict: boolean) => ({
    model: GROQ_MODEL, temperature: 0.1, reasoning_effort: "low",
    messages: [{ role: "system", content: systemPrompt(ctx) }, { role: "user", content: text }],
    response_format: strict
      ? { type: "json_schema", json_schema: { name: "noctis_actions", strict: true, schema: SCHEMA } }
      : { type: "json_object" },
  });
  for (const strict of [true, false]) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body(strict)),
    });
    if (r.status === 429) throw new GroqLimit("limit");
    const j = await r.json().catch(() => null);
    if (!r.ok) { console.error("groq", r.status, JSON.stringify(j)); if (strict) continue; throw new Error("groq " + r.status); }
    try {
      const out = JSON.parse(j.choices[0].message.content);
      if (out && Array.isArray(out.actions)) return out;
    } catch { /* попробуем без строгой схемы */ }
  }
  throw new Error("groq: bad json");
}
async function transcribe(fileId: string): Promise<string> {
  const f = await tg("getFile", { file_id: fileId });
  if (!f.ok) throw new Error("getFile");
  const audio = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`);
  if (!audio.ok) throw new Error("download");
  const fd = new FormData();
  fd.append("file", new Blob([await audio.arrayBuffer()], { type: "audio/ogg" }), "voice.ogg");
  fd.append("model", STT_MODEL);
  fd.append("response_format", "json");
  fd.append("temperature", "0");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: fd,
  });
  if (r.status === 429) throw new GroqLimit("limit");
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error("stt " + r.status);
  return String(j.text ?? "").trim();
}

/* ======================= Проверка и подготовка действий ======================= */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/ё/g, "е").trim();
function findOne<T extends { name: string }>(list: T[], name: unknown): T | null | "many" {
  const n = norm(name); if (!n) return null;
  const exact = list.filter((x) => norm(x.name) === n); if (exact.length === 1) return exact[0];
  const part = list.filter((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
  return part.length === 1 ? part[0] : part.length > 1 ? "many" : null;
}
type Plan = { recs: Rec[]; lines: string[]; finance: boolean; issues: string[]; answers: string[] };
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

function resolveAccount(ctx: Ctx, name: unknown, currency: unknown): { acc?: any; err?: string } {
  const list = ctx.accounts;
  if (!list.length) return { err: "У вас пока нет балансов — создайте их в приложении: Финансы → «Добавить баланс»." };
  if (name) {
    const a = findOne(list, name);
    if (a && a !== "many") return { acc: a };
    return { err: `Не нашёл баланс «${escHtml(name)}». Есть: ${list.map((x) => escHtml(x.name)).join(", ")}.` };
  }
  if (list.length === 1) return { acc: list[0] };
  const cur = typeof currency === "string" ? currency.toUpperCase() : "";
  const byCur = cur ? list.filter((a) => a.currency === cur) : [];
  if (byCur.length === 1) return { acc: byCur[0] };
  return { err: `С какого баланса? ${list.map((x) => escHtml(x.name)).join(", ")}. Напишите команду ещё раз с названием баланса.` };
}

function buildPlan(ctx: Ctx, out: any, updateId: number, transcript: string | null): Plan {
  const p: Plan = { recs: [], lines: [], finance: false, issues: [], answers: [] };
  const acts: any[] = Array.isArray(out.actions) ? out.actions.slice(0, 10) : [];
  const createdAt = Date.now();
  acts.forEach((a, i) => {
    const id = `b${updateId}x${i}`;
    const title = cap(String(a.title ?? "").trim().slice(0, 200));
    switch (a.type) {
      case "create_task": {
        if (!title) { p.issues.push("Не понял, какую задачу создать."); break; }
        const date = isYmd(a.date) ? a.date : ctx.today; const time = isHm(a.time) ? a.time : "";
        p.recs.push({ kind: "task", id, data: { id, title, description: "", photos: [], starred: false, date, time, status: "pending", createdAt, source: "bot" } });
        p.lines.push(`📅 Задача на ${human(date, ctx.today)}${time ? " в " + time : ""}: <b>${escHtml(title)}</b>`);
        break;
      }
      case "create_rule": {
        if (!title) { p.issues.push("Не понял, что повторять."); break; }
        const days = [...new Set((a.days ?? []).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[];
        const start = isYmd(a.start_date) ? a.start_date : ctx.today; const end = isYmd(a.end_date) && a.end_date >= start ? a.end_date : "";
        const dd = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
        p.recs.push({ kind: "rule", id, data: { id, title, description: "", days: dd, start, end, time: isHm(a.time) ? a.time : "", paused: false, done: {}, createdAt, source: "bot" } });
        const dtxt = dd.length === 7 ? "каждый день" : dd.join() === "0,1,2,3,4" ? "по будням" : dd.map((d) => ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][d]).join(", ");
        p.lines.push(`🔁 Повтор ${dtxt}${isHm(a.time) ? " в " + a.time : ""}: <b>${escHtml(title)}</b>${end ? ` (до ${human(end, ctx.today)})` : ""}`);
        break;
      }
      case "create_goal": {
        if (!title) { p.issues.push("Не понял, какую цель добавить."); break; }
        const month = typeof a.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) ? a.month : ctx.today.slice(0, 7);
        const target = Number.isInteger(a.target) && a.target > 0 && a.target <= 100000 ? a.target : null;
        p.recs.push({ kind: "goal", id, data: { id, month, title, description: "", target, progress: 0, done: false, createdAt, source: "bot" } });
        p.lines.push(`🎯 Цель на ${month}: <b>${escHtml(title)}</b>${target ? ` (0 / ${target})` : ""}`);
        break;
      }
      case "create_idea": {
        if (!title) { p.issues.push("Не понял, какую идею записать."); break; }
        const tags = (a.tags ?? []).map((t: unknown) => String(t).trim().replace(/^#/, "").slice(0, 24)).filter(Boolean).slice(0, 3);
        p.recs.push({ kind: "idea", id, data: { id, title: title.slice(0, 120), body: String(a.body ?? "").trim(), tags, status: "new", source: "bot", transcript: transcript ?? "", createdAt } });
        p.lines.push(`💡 Идея: <b>${escHtml(title)}</b>${tags.length ? " · " + tags.map((t: string) => "#" + escHtml(t)).join(" ") : ""}`);
        break;
      }
      case "add_expense": case "add_income": {
        const type = a.type === "add_expense" ? "expense" : "income";
        const amount = parseMoney(a.amount);
        if (!amount) { p.issues.push(`Не понял сумму${a.note ? " для «" + escHtml(a.note) + "»" : ""}. Напишите, например: «потратил 15 евро на продукты».`); break; }
        const { acc, err } = resolveAccount(ctx, a.account, a.currency); if (!acc) { p.issues.push(err!); break; }
        const cur = typeof a.currency === "string" ? a.currency.toUpperCase() : "";
        if (cur && CUR_SIGN[cur] && cur !== acc.currency) { p.issues.push(`Баланс «${escHtml(acc.name)}» в ${acc.currency}, а сумма в ${cur}. Уточните баланс или сумму.`); break; }
        const cats = ctx.categories.filter((c) => c.kind === type);
        let cat: any = findOne(cats, a.category); let catNote = "";
        if (!cat || cat === "many") { cat = cats.find((c) => c.id === (type === "expense" ? "c-other" : "c-other-in")) ?? cats[0]; if (a.category) catNote = ` <i>(категории «${escHtml(a.category)}» нет)</i>`; }
        if (!cat) { p.issues.push("Нет категорий — откройте «Финансы» в приложении один раз."); break; }
        const date = isYmd(a.date) ? a.date : ctx.today; const note = String(a.note ?? "").trim().slice(0, 140);
        p.recs.push({ kind: "txn", id, data: { id, type, amount, accountId: acc.id, categoryId: cat.id, date, note, createdAt, source: "bot" } });
        p.lines.push(`${type === "expense" ? "💸 Расход" : "💰 Доход"}: <b>${fmt(amount, acc.currency)}</b> · ${escHtml(acc.name)} · ${cat.emoji ?? ""} ${escHtml(cat.name)}${catNote}${note ? " · " + escHtml(note) : ""}${date !== ctx.today ? " · " + human(date, ctx.today) : ""}`);
        p.finance = true;
        break;
      }
      case "transfer": {
        const amount = parseMoney(a.amount); if (!amount) { p.issues.push("Не понял сумму перевода."); break; }
        const from = resolveAccount(ctx, a.account, a.currency); if (!from.acc) { p.issues.push(from.err!); break; }
        if (!a.to_account) { p.issues.push("На какой баланс перевести?"); break; }
        const to = findOne(ctx.accounts, a.to_account);
        if (!to || to === "many" || to.id === from.acc.id) { p.issues.push(`Не нашёл баланс для зачисления «${escHtml(a.to_account)}».`); break; }
        const data: any = { id, type: "transfer", amount, accountId: from.acc.id, toAccountId: to.id, date: isYmd(a.date) ? a.date : ctx.today, note: String(a.note ?? "").trim().slice(0, 140), createdAt, source: "bot" };
        if (to.currency !== from.acc.currency) {
          const ta = parseMoney(a.to_amount);
          if (!ta) { p.issues.push(`${escHtml(from.acc.name)} в ${from.acc.currency}, ${escHtml(to.name)} в ${to.currency}. Сколько ${to.currency} пришло? Напишите, например: «перевёл 100 евро с Revolut на Monobank, пришло 4350 гривен».`); break; }
          data.toAmount = ta;
        }
        p.recs.push({ kind: "txn", id, data });
        p.lines.push(`🔄 Перевод: <b>${fmt(amount, from.acc.currency)}</b> ${escHtml(from.acc.name)} → ${escHtml(to.name)}${data.toAmount ? ` (+${fmt(data.toAmount, to.currency)})` : ""}`);
        p.finance = true;
        break;
      }
      case "query_spending": case "query_income": p.answers.push(answerMoney(ctx, a, a.type === "query_spending" ? "expense" : "income")); break;
      case "query_tasks": p.answers.push(answerTasks(ctx, isYmd(a.date) ? a.date : ctx.today)); break;
      case "query_balance": p.answers.push(answerBalance(ctx, a.account)); break;
    }
  });
  return p;
}

/* ======================= Ответы на вопросы (считает код, не модель) ======================= */
function answerMoney(ctx: Ctx, a: any, type: "expense" | "income") {
  const to = isYmd(a.period_to) ? a.period_to : ctx.today;
  const from = isYmd(a.period_from) && a.period_from <= to ? a.period_from : addDays(to, -6);
  let list = ctx.txns.filter((t) => t.type === type && t.date >= from && t.date <= to);
  let filt = "";
  if (a.account) { const acc = findOne(ctx.accounts, a.account); if (acc && acc !== "many") { list = list.filter((t) => t.accountId === acc.id); filt += ` · ${escHtml(acc.name)}`; } }
  if (a.category) {
    const cat = findOne(ctx.categories.filter((c) => c.kind === type), a.category);
    if (cat && cat !== "many") { list = list.filter((t) => t.categoryId === cat.id); filt += ` · ${escHtml(cat.name)}`; }
    else return `Не нашёл категорию «${escHtml(a.category)}».`;
  }
  const accCur = (id: string) => ctx.accounts.find((x) => x.id === id)?.currency ?? ctx.mainCur;
  const sums: Record<string, number> = {}; const byCat: Record<string, number> = {};
  for (const t of list) { const c = accCur(t.accountId); sums[c] = (sums[c] || 0) + t.amount; if (c === ctx.mainCur) byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount; }
  const head = `${type === "expense" ? "💸 Расходы" : "💰 Доходы"} с ${human(from, ctx.today)} по ${human(to, ctx.today)}${filt}:`;
  if (!list.length) return `${head} операций нет.`;
  const total = Object.entries(sums).map(([c, v]) => `<b>${fmt(v, c)}</b>`).join(" + ");
  const top = Object.entries(byCat).sort((x, y) => y[1] - x[1]).slice(0, 5)
    .map(([id, v]) => { const c = ctx.categories.find((x) => x.id === id); return `• ${c?.emoji ?? ""} ${escHtml(c?.name ?? "Без категории")} — ${fmt(v, ctx.mainCur)}`; });
  return `${head} ${total} (${list.length} опер.)${top.length > 1 && !a.category ? "\n" + top.join("\n") : ""}`;
}
function answerTasks(ctx: Ctx, date: string) {
  const tasks = ctx.tasks.filter((t) => t.date === date && t.status !== "postponed");
  const rules = ctx.rules.filter((r) => !r.paused && r.start <= date && (!r.end || date <= r.end) && (r.days ?? [0, 1, 2, 3, 4, 5, 6]).includes(wdIdx(date)));
  const items = [
    ...tasks.map((t) => ({ t: t.time || "", s: `${t.status === "done" ? "✅" : "⬜️"} ${t.time ? t.time + " " : ""}${escHtml(t.title)}` })),
    ...rules.map((r) => ({ t: r.time || "", s: `${r.done?.[date] ? "✅" : "⬜️"} ${r.time ? r.time + " " : ""}${escHtml(r.title)} 🔁` })),
  ].sort((x, y) => (x.t || "99").localeCompare(y.t || "99"));
  return items.length ? `📋 Задачи на ${human(date, ctx.today)}:\n${items.map((x) => x.s).join("\n")}` : `📋 На ${human(date, ctx.today)} задач нет.`;
}
function answerBalance(ctx: Ctx, name: unknown) {
  const b = balances(ctx);
  let list = ctx.accounts;
  if (name) { const a = findOne(list, name); if (!a || a === "many") return `Не нашёл баланс «${escHtml(name)}».`; list = [a]; }
  if (!list.length) return "Балансов пока нет — создайте их в приложении.";
  return `💳 Балансы:\n${list.map((a) => `• ${escHtml(a.name)} — <b>${fmt(b[a.id] || 0, a.currency)}</b>`).join("\n")}`;
}

/* ======================= Обработка сообщения ======================= */
const HELP = `Привет! Я <b>Noctis</b> — ассистент LockedLife. Пишите или говорите голосом, например:
• «Завтра в 16:00 сходить в зал»
• «Каждый день принимать витамины»
• «Запиши идею: сервис для поиска авиабилетов»
• «Потратил 15 евро с Revolut на продукты»
• «Цель на ноябрь — отправить 30 откликов»
• «Сколько я потратил за последнюю неделю?»
• «Что у меня на завтра?» · «Какой баланс?»

Финансовые операции я сохраняю только после вашего подтверждения.`;

async function handleText(chatId: number, uid: number, updateId: number, text: string, transcript: string | null) {
  const ctx = await loadCtx(uid);
  const out = await groqChat(ctx, text.slice(0, MAX_TEXT));
  const plan = buildPlan(ctx, out, updateId, transcript);
  const parts: string[] = [];
  if (plan.answers.length) parts.push(plan.answers.join("\n\n"));
  if (plan.issues.length) parts.push("❓ " + plan.issues.join("\n❓ "));
  if (!plan.recs.length) {
    if (!parts.length) parts.push(escHtml(out.clarification || "Не понял команду. Напишите /help — покажу примеры."));
    else if (out.clarification && !plan.answers.length) parts.push(escHtml(out.clarification));
    await send(chatId, parts.join("\n\n"));
    return;
  }
  const pid = `p${updateId}`;
  const summary = plan.lines.join("\n");
  const needConfirm = plan.finance || plan.recs.length > 3;
  await db.from("bot_pending").insert({ id: pid, user_id: uid, chat_id: chatId, records: plan.recs, summary, status: needConfirm ? "pending" : "done" });
  if (needConfirm) {
    parts.unshift(`Распознал ${plan.recs.length} ${plural(plan.recs.length, "действие", "действия", "действий")}:\n${summary}\n\nВсё правильно?`);
    await send(chatId, parts.join("\n\n"), [[{ text: "✅ Да, сохранить", data: `ok:${pid}` }], [{ text: "✏️ Изменить", data: `edit:${pid}` }]]);
  } else {
    await pushRecords(uid, plan.recs);
    parts.unshift(`Сохранил:\n${summary}`);
    await send(chatId, parts.join("\n\n"), [[{ text: "↩️ Отменить", data: `undo:${pid}` }]]);
  }
}
function plural(n: number, a: string, b: string, c: string) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; }

async function handleCallback(cb: any, uid: number) {
  const [action, pid] = String(cb.data ?? "").split(":");
  const chatId = cb.message?.chat?.id; const msgId = cb.message?.message_id;
  const transitions: Record<string, [string, string]> = { ok: ["pending", "done"], edit: ["pending", "cancelled"], undo: ["done", "undone"] };
  const tr = transitions[action];
  if (!tr || !pid) return tg("answerCallbackQuery", { callback_query_id: cb.id });
  // атомарная смена статуса: двойное нажатие не выполнит действие дважды
  const { data } = await db.from("bot_pending").update({ status: tr[1] })
    .eq("id", pid).eq("user_id", uid).eq("status", tr[0]).select("records,summary,created_at");
  const row = data?.[0];
  if (!row) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Уже обработано" });
  if (action === "undo" && Date.now() - new Date(row.created_at).getTime() > 7 * 86400e3) {
    await db.from("bot_pending").update({ status: "done" }).eq("id", pid);
    return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Отменить можно в течение 7 дней — удалите запись в приложении" });
  }
  let text = "";
  if (action === "ok") { await pushRecords(uid, row.records); text = `✅ Сохранено:\n${row.summary}`; }
  if (action === "edit") text = `✏️ Отменено. Напишите команду заново с исправлениями.\n<s>${row.summary}</s>`;
  if (action === "undo") { await pushRecords(uid, row.records, true); text = `↩️ Отменено:\n<s>${row.summary}</s>`; }
  await tg("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML",
    ...(action === "ok" ? { reply_markup: { inline_keyboard: [[{ text: "↩️ Отменить", callback_data: `undo:${pid}` }]] } } : {}) });
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
}

async function handleUpdate(u: any) {
  const msg = u.message; const cb = u.callback_query;
  const from = msg?.from ?? cb?.from; const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!from || !chatId) return;
  if (msg && msg.chat?.type !== "private") return;                       // только личные сообщения
  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(String(from.id))) {
    if (msg) await send(chatId, "Это личный ассистент — доступ закрыт.");
    return;
  }
  const uid = Number(from.id);
  try {
    if (cb) return await handleCallback(cb, uid);
    if (Math.random() < 0.02) db.rpc("bot_cleanup").then(() => {});
    const text: string = msg.text ?? msg.caption ?? "";
    if (/^\/(start|help)\b/.test(text)) return void await send(chatId, HELP);
    if (/^\/today\b/.test(text)) { const ctx = await loadCtx(uid); return void await send(chatId, answerTasks(ctx, ctx.today)); }
    if (/^\/balance\b/.test(text)) { const ctx = await loadCtx(uid); return void await send(chatId, answerBalance(ctx, null)); }
    const voice = msg.voice ?? msg.audio;
    if (voice) {
      if ((voice.duration ?? 0) > MAX_VOICE_SEC) return void await send(chatId, "Голосовое длиннее 5 минут — разделите, пожалуйста, на части.");
      await tg("sendChatAction", { chat_id: chatId, action: "typing" });
      const t = await transcribe(voice.file_id);
      if (!t) return void await send(chatId, "Не удалось разобрать голосовое. Попробуйте ещё раз или напишите текстом.");
      await send(chatId, `🎙 <i>${escHtml(t)}</i>`);
      return await handleText(chatId, uid, u.update_id, t, t);
    }
    if (text) { await tg("sendChatAction", { chat_id: chatId, action: "typing" }); return await handleText(chatId, uid, u.update_id, text, null); }
    await send(chatId, "Я понимаю текст и голосовые сообщения.");
  } catch (e) {
    console.error(e);
    await send(chatId, e instanceof GroqLimit
      ? "⏳ Бесплатный лимит ИИ временно исчерпан. Попробуйте через несколько минут."
      : "⚠️ Не получилось обработать сообщение. Попробуйте ещё раз чуть позже.");
  }
}

/* ======================= HTTP ======================= */
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // путь бывает "/<имя-функции>/setup" или "/functions/v1/<имя-функции>/setup" — берём часть после имени функции
  let parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "functions" && parts[1] === "v1") parts = parts.slice(2);
  const route = parts.length > 1 ? "/" + parts.slice(1).join("/") : "/";

  if (req.method === "GET" && route === "/health")
    return json({ ok: true, token: !!TOKEN, webhookSecret: WEBHOOK_SECRET.length >= 16, groq: !!GROQ_KEY, allowed: ALLOWED_IDS.length, tz: TZ, model: GROQ_MODEL });

  if (req.method === "GET" && route === "/setup") {
    if (!WEBHOOK_SECRET || !safeEqual(url.searchParams.get("key") ?? "", WEBHOOK_SECRET)) return json({ error: "wrong key" }, 403);
    const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${parts[0]}`;
    const r1 = await tg("setWebhook", { url: hookUrl, secret_token: WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true, max_connections: 10 });
    const r2 = await tg("setMyCommands", { commands: [
      { command: "today", description: "Задачи на сегодня" },
      { command: "balance", description: "Балансы" },
      { command: "help", description: "Что я умею" },
    ] });
    return json({ webhook: r1.ok ? "ok" : r1.description, commands: r2.ok ? "ok" : r2.description, url: hookUrl });
  }

  if (req.method !== "POST") return json({ error: "not found" }, 404);
  if (!WEBHOOK_SECRET || !safeEqual(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", WEBHOOK_SECRET)) return json({ error: "forbidden" }, 403);

  const u = await req.json().catch(() => null);
  if (!u || typeof u.update_id !== "number") return json({ ok: true });
  // защита от повторной обработки: номер сообщения записывается один раз
  const { error } = await db.from("bot_updates").insert({ update_id: u.update_id });
  if (error) { if (error.code === "23505") return json({ ok: true, duplicate: true }); console.error("dedupe", error); return json({ error: "db" }, 500); }

  const work = handleUpdate(u);
  // отвечаем Telegram сразу, а обработку продолжаем в фоне
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(work); return json({ ok: true }); }
  await work; return json({ ok: true });
});
