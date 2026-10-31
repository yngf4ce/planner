// LockedLife — серверная функция `api` (Supabase Edge Function).
// Принимает запросы Mini App, проверяет, что они пришли от Telegram и от разрешённого пользователя,
// и только потом читает/пишет данные. Ключи хранятся в Supabase → Edge Functions → Secrets.
//
// Маршруты (их уже использует index.html):
//   POST   /api/sync          — отправить изменения и получить новые
//   GET    /api/photos/:id    — скачать фото
//   PUT    /api/photos/:id    — загрузить фото (image/jpeg, до 5 МБ)
//   DELETE /api/photos/:id    — удалить фото
//
// ВАЖНО: в настройках функции выключите «Verify JWT» (Enforce JWT verification) —
// приложение авторизуется подписью Telegram, а не ключом Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ALLOWED_IDS = (Deno.env.get("ALLOWED_TELEGRAM_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_AGE_SEC = 3 * 24 * 3600; // подпись Telegram действительна 3 дня
const KINDS = new Set(["task", "diary", "settings", "goal", "rule"]);
const MAX_CHANGES = 500;
const MAX_RECORD_BYTES = 200_000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

/* ---------- CORS ---------- */
function corsHeaders(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, h: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

/* ---------- проверка Telegram initData ---------- */
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyInitData(initData: string): Promise<number | null> {
  if (!BOT_TOKEN || !initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const checkString = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT_TOKEN);
  if (!safeEqual(toHex(await hmac(secret, checkString)), hash)) return null;
  const authDate = Number(p.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  let user: { id?: number } | null = null;
  try { user = JSON.parse(p.get("user") ?? "null"); } catch { return null; }
  const id = user && Number(user.id);
  if (!id) return null;
  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(String(id))) return null;
  return id;
}

/* ---------- синхронизация ---------- */
type Change = { kind: string; id: string; updatedAt: number; deleted: boolean; data: unknown };
function validChange(c: any): c is Change {
  return c && typeof c === "object" && KINDS.has(c.kind) &&
    typeof c.id === "string" && c.id.length > 0 && c.id.length <= 100 &&
    Number.isFinite(c.updatedAt) && c.updatedAt > 0 &&
    (c.deleted === true || (c.data !== undefined && JSON.stringify(c.data).length <= MAX_RECORD_BYTES));
}
async function handleSync(req: Request, uid: number, h: Record<string, string>) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.changes)) return json({ error: "bad request" }, 400, h);
  if (body.changes.length > MAX_CHANGES) return json({ error: "too many changes" }, 413, h);
  const changes = body.changes.filter(validChange).map((c: Change) => ({
    kind: c.kind, id: c.id, updatedAt: Math.floor(c.updatedAt), deleted: !!c.deleted, data: c.deleted ? null : c.data,
  }));
  if (changes.length) {
    const { error } = await db.rpc("sync_push", { p_user: uid, p_changes: changes });
    if (error) { console.error("sync_push", error); return json({ error: "db" }, 500, h); }
  }
  const since = Math.max(0, Number(body.since) || 0);
  const { data, error } = await db.from("records")
    .select("kind,id,data,deleted,updated_at,seq")
    .eq("user_id", uid).gt("seq", since).order("seq", { ascending: true }).limit(2000);
  if (error) { console.error("pull", error); return json({ error: "db" }, 500, h); }
  const rows = data ?? [];
  return json({
    changes: rows.map((r) => ({ kind: r.kind, id: r.id, data: r.data, deleted: r.deleted, updatedAt: Number(r.updated_at) })),
    seq: rows.length ? Number(rows[rows.length - 1].seq) : since,
  }, 200, h);
}

/* ---------- фото ---------- */
async function handlePhoto(req: Request, uid: number, id: string, h: Record<string, string>) {
  const path = `${uid}/${id}.jpg`;
  const bucket = db.storage.from("photos");
  if (req.method === "GET") {
    const { data, error } = await bucket.download(path);
    if (error || !data) return json({ error: "not found" }, 404, h);
    return new Response(data, { status: 200, headers: { ...h, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000" } });
  }
  if (req.method === "PUT") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "size" }, 413, h);
    const { error } = await bucket.upload(path, buf, { contentType: "image/jpeg", upsert: true });
    if (error) { console.error("upload", error); return json({ error: "storage" }, 500, h); }
    return json({ ok: true }, 200, h);
  }
  if (req.method === "DELETE") {
    await bucket.remove([path]);
    return json({ ok: true }, 200, h);
  }
  return json({ error: "method" }, 405, h);
}

/* ---------- маршрутизация ---------- */
Deno.serve(async (req) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

  const route = (new URL(req.url).pathname.match(/\/api(\/.*)$/) ?? [])[1] ?? "";
  if (route === "/health") return json({ ok: true, configured: !!BOT_TOKEN }, 200, h);

  const auth = req.headers.get("Authorization") ?? "";
  const uid = auth.startsWith("tma ") ? await verifyInitData(auth.slice(4)) : null;
  if (!uid) return json({ error: "auth" }, 401, h);

  try {
    if (route === "/sync" && req.method === "POST") return await handleSync(req, uid, h);
    const pm = route.match(/^\/photos\/([A-Za-z0-9_-]{1,64})$/);
    if (pm) return await handlePhoto(req, uid, pm[1], h);
    return json({ error: "not found" }, 404, h);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500, h);
  }
});
