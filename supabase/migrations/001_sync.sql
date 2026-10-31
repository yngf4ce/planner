-- LockedLife — миграция 001: синхронизация данных планера
-- Как применить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run.
-- Повторный запуск безопасен (ничего не удалит).

-- 1. Все записи планера (задачи, дневник, настройки, цели, повторы) в одной таблице.
--    Ключ — (Telegram ID пользователя, тип, id записи). data — сама запись в JSON.
create table if not exists public.records (
  user_id    bigint  not null,
  kind       text    not null check (kind in ('task', 'diary', 'settings', 'goal', 'rule')),
  id         text    not null check (char_length(id) between 1 and 100),
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,              -- время изменения на устройстве (мс)
  seq        bigint  not null,              -- порядковый номер изменения для синхронизации
  primary key (user_id, kind, id)
);
create sequence if not exists public.records_seq;
create index if not exists records_user_seq on public.records (user_id, seq);

-- 2. Защита: RLS включён, разрешающих политик НЕТ.
--    Публичные ключи (anon/authenticated) не могут ни читать, ни писать.
--    Доступ есть только у серверной функции `api` (service_role), которая сама проверяет пользователя.
alter table public.records enable row level security;
revoke all on public.records from anon, authenticated;
revoke all on sequence public.records_seq from anon, authenticated;

-- 3. Приём изменений с устройства: запись обновляется, только если пришла более новая версия.
create or replace function public.sync_push(p_user bigint, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare c jsonb;
begin
  for c in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    insert into records (user_id, kind, id, data, deleted, updated_at, seq)
    values (
      p_user,
      c->>'kind',
      c->>'id',
      case when coalesce((c->>'deleted')::boolean, false) then null else c->'data' end,
      coalesce((c->>'deleted')::boolean, false),
      (c->>'updatedAt')::bigint,
      nextval('records_seq')
    )
    on conflict (user_id, kind, id) do update
      set data = excluded.data, deleted = excluded.deleted,
          updated_at = excluded.updated_at, seq = excluded.seq
      where records.updated_at < excluded.updated_at;
  end loop;
end;
$$;
revoke execute on function public.sync_push(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sync_push(bigint, jsonb) to service_role;

-- 4. Приватное хранилище фото (до 5 МБ на файл). Публичного доступа нет.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;
