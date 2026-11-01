-- LockedLife — миграция 003: служебные таблицы бота Noctis AI
-- Как применить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run. Повторный запуск безопасен.

-- 1. Обработанные сообщения Telegram. Если Telegram пришлёт то же сообщение повторно
--    (например, при сбое сети), бот увидит его номер здесь и не выполнит команду второй раз.
create table if not exists public.bot_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

-- 2. Команды, ожидающие подтверждения («Да, сохранить» / «Изменить»), и выполненные команды (для «Отменить»).
create table if not exists public.bot_pending (
  id         text primary key,
  user_id    bigint not null,
  chat_id    bigint not null,
  records    jsonb  not null,           -- записи, которые будут созданы: [{kind, id, data}]
  summary    text   not null,           -- текст подтверждения
  status     text   not null default 'pending' check (status in ('pending', 'done', 'cancelled', 'undone')),
  created_at timestamptz not null default now()
);
create index if not exists bot_pending_user on public.bot_pending (user_id, created_at desc);

-- 3. Защита: только серверные функции (service_role) имеют доступ.
alter table public.bot_updates enable row level security;
alter table public.bot_pending enable row level security;
revoke all on public.bot_updates from anon, authenticated;
revoke all on public.bot_pending from anon, authenticated;

-- 4. Уборка: номера сообщений старше 30 дней больше не нужны (вызывается ботом изредка).
create or replace function public.bot_cleanup() returns void
language sql security definer set search_path = public as $$
  delete from bot_updates where created_at < now() - interval '30 days';
  delete from bot_pending where created_at < now() - interval '30 days';
$$;
revoke execute on function public.bot_cleanup() from public, anon, authenticated;
grant execute on function public.bot_cleanup() to service_role;
