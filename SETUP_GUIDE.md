# Инструкция по настройке LockedLife (для новичка)

Разделы добавляются по мере развития проекта. Делайте только тот раздел, о котором идёт речь сейчас.

---

## 0. Резервная копия данных (делать перед каждым крупным изменением)

1. Откройте приложение в Telegram.
2. Нажмите ⚙️ (справа вверху) → **«Сохранить резервную копию»**.
3. Сохраните файл `planner-backup-ГГГГ-ММ-ДД.json` себе в «Избранное» Telegram или на диск.

Восстановление: ⚙️ → «Восстановить из копии» → выбрать этот файл.

---

## 1. Доступ Claude к репозиторию

Чтобы Claude мог сам сохранять изменения в GitHub:

1. Откройте https://github.com/apps/claude/installations/select_target
2. Выберите свой аккаунт `yngf4ce`.
3. **Only select repositories** → отметьте `planner` → **Install**.
4. Если просит — подтвердите в claude.ai: Settings → Connectors → GitHub.

Альтернатива без доступа: Claude присылает файлы, вы загружаете их в GitHub через
**Add file → Upload files** → **Commit changes**.

---

## 2. Хостинг Mini App (GitHub Pages — бесплатно)

1. GitHub → репозиторий `planner` → **Settings** → **Pages**.
2. Source: **Deploy from a branch**, Branch: **main**, папка **/ (root)** → **Save**.
3. Через 1–2 минуты появится адрес вида `https://yngf4ce.github.io/planner/`.
4. Откройте его в браузере — должен открыться ежедневник.

## 3. Подключение к боту

1. Откройте в Telegram **@BotFather** → `/mybots` → ваш бот.
2. **Bot Settings** → **Menu Button** → **Configure menu button**.
3. Отправьте адрес из шага 2 (обязательно `https://`), затем название кнопки, например `LockedLife`.
4. Откройте чат с ботом → кнопка слева от поля ввода → приложение откроется.

**Ваш Telegram ID** (понадобится для ограничения доступа): напишите боту **@userinfobot** — он ответит числом `Id`.
Это не секрет, но и публиковать его незачем.

---

## 4. Бесплатные лимиты (проверено 31.10.2026, перепроверяйте перед подключением)

| Сервис | Что даёт бесплатно | На что обратить внимание |
|---|---|---|
| Supabase Free | 2 проекта, БД 500 МБ, файлы 1 ГБ, 500 000 вызовов Edge Functions в месяц | **Проект ставится на паузу после 7 дней без активности** — данные не теряются, но нужно вручную «разбудить» |
| Groq (Whisper) | ~20 запросов/мин, 2 000 запросов/день, 28 800 секунд аудио/день | Без карты. Лимиты — на всю организацию, а не на ключ |
| Gemini API | Есть бесплатный уровень для моделей Flash/Flash‑Lite; дневные лимиты менялись несколько раз | Точные цифры смотрите в AI Studio вашего проекта. На бесплатном уровне иные условия использования данных — для финансов это важно |
| GitHub Pages | Статический хостинг, ~100 ГБ трафика/мес | Достаточно для личного приложения |
| Cloudflare Pages | Безлимитный трафик статики, 500 сборок/мес | Альтернатива GitHub Pages |

Где смотреть официальные цифры:
- Supabase: https://supabase.com/pricing
- Groq: https://console.groq.com/docs/rate-limits (и Settings → Limits в консоли)
- Gemini: https://ai.google.dev/gemini-api/docs/rate-limits и https://ai.google.dev/gemini-api/terms
- Cloudflare Pages: https://developers.cloudflare.com/pages/platform/limits/

---

## 5. Сервер Supabase (этап 3)

Что получится: задачи, цели, повторы, дневник и фото хранятся на сервере и синхронизируются между устройствами.
Приложение по‑прежнему работает без интернета — изменения отправятся, когда связь появится.

### 5.1. Аккаунт и проект
1. Откройте https://supabase.com → **Start your project** → войдите через GitHub (аккаунт `yngf4ce`).
2. **New project**:
   - Organization — ваша (тариф **Free**);
   - Name: `lockedlife`;
   - Database Password: нажмите **Generate a password** и сохраните его в менеджер паролей (в чат не отправлять);
   - Region: **Central EU (Frankfurt)** — ближе всего к вам;
   - **Create new project** и подождите 1–2 минуты.
3. Откройте **Project Settings → General** (или **Data API**) и найдите **Project URL** вида
   `https://abcdefghijkl.supabase.co`. Этот адрес **не секретный** — его можно прислать Claude.

### 5.2. Таблицы (SQL)
1. Слева **SQL Editor** → **New query**.
2. Откройте в GitHub файл `supabase/migrations/001_sync.sql` → кнопка **Raw** → выделите всё → скопируйте.
3. Вставьте в SQL Editor → **Run**. Ожидаемый результат: `Success. No rows returned`.
4. Проверка: слева **Table Editor** → появилась таблица `records`; **Storage** → бакет `photos` (Private).

### 5.3. Секреты
**Edge Functions → Secrets** (или **Project Settings → Edge Functions → Secrets**) → добавьте:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота из @BotFather (`/mybots` → бот → **API Token**) |
| `ALLOWED_TELEGRAM_IDS` | ваш Telegram ID (число от @userinfobot) |
| `ALLOWED_ORIGINS` | `https://yngf4ce.github.io` |

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` добавлять не нужно — они уже есть внутри функций.

### 5.4. Серверная функция `api`
1. **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Имя функции: `api` (строго так).
3. Удалите пример кода, вставьте содержимое `supabase/functions/api/index.ts` (GitHub → файл → **Raw** → скопировать всё).
4. **Deploy function**.
5. В настройках функции (**Details / Settings**) **выключите «Enforce JWT verification» / «Verify JWT»** → Save.
   Без этого Supabase отклонит запросы приложения (оно авторизуется подписью Telegram).
6. Проверка: откройте в браузере `https://ВАШ_ID.supabase.co/functions/v1/api/health` →
   должно быть `{"ok":true,"configured":true}`. Если `configured:false` — не задан `TELEGRAM_BOT_TOKEN`.

> **Важно про адрес.** Supabase может дать функции случайный адрес (например, `hyper-function`), даже если имя — `api`.
> Рабочий адрес виден в списке функций, в колонке **URL**. У LockedLife сейчас:
> `https://muyrgklzrimnzipjcgil.supabase.co/functions/v1/hyper-function` (проверка: добавить `/api/health`).

### 5.5. Включение синхронизации в приложении
Claude вписывает адрес `https://ВАШ_ID.supabase.co/functions/v1` в `index.html`
(`<meta name="api-base" ...>`) и публикует. После этого: ⚙️ → «Синхронизация» должна показать «Включена · ЧЧ:ММ».

### Частые ошибки
| Симптом | Причина и решение |
|---|---|
| `/api/health` отвечает 401 «Missing authorization header» | не выключена проверка JWT (шаг 5.4.5) |
| В приложении «Перезапустите приложение из Telegram» | неверный `TELEGRAM_BOT_TOKEN`, не тот ID в `ALLOWED_TELEGRAM_IDS`, или приложение открыто не через бота |
| «Сервер недоступен» | функция не задеплоена, неверное имя (`api`), или неверный адрес в `api-base` |
| Проект «Paused» | бесплатный проект засыпает после 7 дней без активности — Dashboard → **Restore project** |

### 5.6. Обновления сервера
Когда в репозитории появляется новая миграция (`supabase/migrations/00N_*.sql`) или меняется `supabase/functions/api/index.ts`:
1. **SQL Editor** → вставить новый файл миграции → **Run** (старые миграции повторять не нужно, но это безопасно).
2. **Edge Functions** → функция **api** → вкладка **Code** → заменить код целиком → **Deploy**.
   После деплоя проверить, что «Enforce JWT verification» по‑прежнему выключен.

| Миграция | Что делает |
|---|---|
| `001_sync.sql` | таблица `records`, бакет `photos` |
| `002_kinds.sql` | разрешает новые типы записей (финансы и будущие разделы) |

---

## 6. Groq, Gemini, бот Noctis AI — будет добавлено на этапе 6

Секреты всегда вводятся только в панелях сервисов, никогда — в код и не в чат. Список переменных — в `.env.example`.
