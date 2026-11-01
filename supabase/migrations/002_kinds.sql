-- LockedLife — миграция 002: разрешить новые типы записей (финансы, а в будущем идеи, здоровье и т.д.)
-- Как применить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run. Повторный запуск безопасен.

alter table public.records drop constraint if exists records_kind_check;
alter table public.records add constraint records_kind_check check (kind ~ '^[a-z_]{2,24}$');

-- Индекс для будущих отчётов бота (например, «сколько потратил за неделю»): быстрый поиск записей пользователя по типу.
create index if not exists records_user_kind on public.records (user_id, kind) where not deleted;
