# Telegram webhook через Cloudflare Worker

Схема: **Telegram → Cloudflare Worker → GitHub Issue → ответ в Telegram**.
Сообщение обрабатывается за 1–2 секунды, GitHub Actions cron больше не нужен.

```
Telegram (ваше сообщение)
   │  HTTPS POST + X-Telegram-Bot-Api-Secret-Token
   ▼
Cloudflare Worker  ──►  GitHub API: создать Issue с меткой telegram-task
   │
   └──►  Telegram: ответ «✅ Задача принята: Issue #N»
```

Код Worker: [`cloudflare/telegram-webhook.js`](../cloudflare/telegram-webhook.js).

## Что понадобится

- Бесплатный аккаунт Cloudflare: https://dash.cloudflare.com/sign-up
- Токен бота от **@BotFather** (он же используется в GitHub-секрете `TELEGRAM_BOT_TOKEN`).
- GitHub fine-grained token для Worker (создадим ниже).
- 20–30 минут.

## 1. GitHub-токен для Worker

Worker будет создавать Issues от вашего имени.

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. Repository access: **Only select repositories** → `avovka0-spec/price-radar`.
3. Permissions → Repository permissions:
   - **Issues: Read and write**
   - **Metadata: Read-only** (добавится автоматически)
4. Generate token и скопируйте его (`github_pat_...`).

Классический broad-scope токен сюда не кладите — Worker'у достаточно прав на Issues одного репозитория.

## 2. Секрет webhook

Сгенерируйте случайную строку (64 hex-символа):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Сохраните её — она понадобится в двух местах: в Worker и в GitHub-секрете
`TELEGRAM_WEBHOOK_SECRET`.

## 3. Создание Worker в Cloudflare

1. Откройте https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Workers** → **Hello World**.
2. Имя: `price-radar-tg` → **Deploy**.
3. Нажмите **Edit code**, удалите шаблон и вставьте содержимое
   [`cloudflare/telegram-webhook.js`](../cloudflare/telegram-webhook.js) → **Deploy**.
4. Откройте **Settings** → **Variables and Secrets** и добавьте:

| Имя | Тип | Значение |
|---|---|---|
| `GH_TOKEN` | Secret | fine-grained токен из шага 1 |
| `GH_OWNER` | Text | `avovka0-spec` |
| `GH_REPO` | Text | `price-radar` |
| `TELEGRAM_CHAT_ID` | Text | `1782021699` |
| `WEBHOOK_SECRET` | Secret | строка из шага 2 |
| `TELEGRAM_BOT_TOKEN` | Secret | токен бота (для ответов «Issue #N создан») |

`TELEGRAM_BOT_TOKEN` можно не добавлять — тогда Worker будет создавать Issues молча.
Но с ним удобнее: вы сразу видите номер Issue в Telegram.

5. Скопируйте URL Worker'а из раздела **Overview** (вида
   `https://price-radar-tg.<ваш-поддомен>.workers.dev`). Это адрес для `setWebhook`.

> Проверка: если открыть URL в браузере, Worker ответит `405 Method Not Allowed` —
> это нормально, он принимает только POST от Telegram.

### Если редактор Cloudflare не загружается

В РФ панель Cloudflare иногда не подгружает редактор кода: пустой экран,
в Preview — `Token and remote not found`. Это глюк панели, а не Worker'а.
Можно задеплоить через Wrangler CLI из папки `cloudflare`:

```powershell
cd D:\Prog_dev\ai\price-radar\cloudflare
npx wrangler login
npx wrangler deploy
```

`npx wrangler login` откроет браузер — войдите в тот же аккаунт Cloudflare и
разрешите доступ. После деплоя задайте секреты (каждая команда спросит значение):

```powershell
npx wrangler secret put GH_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Проверка: `curl.exe -i https://price-radar-tg.avovka0.workers.dev/` должен вернуть
`405 Method Not Allowed`, а не `Hello World!`.

## 4. GitHub-секрет для управления webhook

В репозитории: **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `TELEGRAM_WEBHOOK_SECRET`
- Value: та же строка из шага 2

Токен бота уже лежит в секрете `TELEGRAM_BOT_TOKEN`.

## ## Команды бота

После деплоя Worker бот отвечает на:

- `/status` — последние задачи `telegram-task` и их состояние (очередь / выполняется по данным GitHub / готово / ошибка).
- `/status <N>` — состояние конкретного Issue, например `/status 8`.
- `/help` — справка.

Статус берётся из GitHub Issues/комментариев. Реальное исполнение делает локальный OpenCode watcher на ПК (обычно до ~5 минут после создания Issue, ПК должен быть включён).

## 5. Включение webhook

1. GitHub → **Actions** → workflow **telegram-webhook** → **Run workflow**.
2. `action` = **set**, `url` = URL Worker'а из шага 3.
3. Запустите и проверьте лог:
   ```json
   {"ok":true,"result":true,"description":"Webhook was set"}
   ```
4. Запустите ещё раз с `action` = **info**. В ответе должно быть:
   - `url` — ваш Worker URL;
   - `pending_update_count` — 0 (или небольшое число);
   - `last_error_message` — отсутствует.

Если `last_error_message` есть — смотрите раздел «Если не работает».

## 6. Отключение polling

В этом же коммите расписание `telegram-to-issues` закомментировано: Telegram **не разрешает
одновременно webhook и `getUpdates`** — иначе polling начнёт падать с `409 Conflict`.

Workflow `telegram-to-issues` остаётся для ручного запуска и отката.

## 7. Проверка

Отправьте боту сообщение с задачей, например:

```
Добавь поддержку Ozon в воркер цен
```

Ожидаемый результат:

1. Ответ в Telegram: `✅ Задача принята: Issue #N https://github.com/...`
2. Issue с меткой `telegram-task` появляется сразу.

Если ответа нет:

- Cloudflare → Workers & Pages → `price-radar-tg` → **Logs** (Real-time logs) —
  там видно `created issue #N` или текст ошибки.
- Actions → `telegram-webhook` → `action=info` → поле `last_error_message`.
- Проверьте, что `WEBHOOK_SECRET` в Worker и `TELEGRAM_WEBHOOK_SECRET` в GitHub совпадают.
- Проверьте, что `TELEGRAM_CHAT_ID` — именно ваш chat_id.

## 8. Откат на polling

1. Actions → `telegram-webhook` → `action=delete`.
2. В `.github/workflows/telegram-to-issues.yml` раскомментируйте блок `schedule`.
3. При желании удалите Worker в Cloudflare.

После `deleteWebhook` старый polling снова заработает (с теми же ограничениями cron).

## Безопасность

- `WEBHOOK_SECRET` передаётся Telegram в заголовке
  `X-Telegram-Bot-Api-Secret-Token`; Worker отклоняет запросы без него (403).
- `TELEGRAM_CHAT_ID` — второй фильтр: задачи принимаются только из вашего чата.
- Токены хранятся в секретах Worker, а не в коде и не в URL.
- Worker URL публичный, но без секрета создать Issue через него нельзя.
- GitHub-токен — fine-grained, только Issues одного репозитория.

## Лимиты бесплатного плана

- 100 000 запросов/день (нам нужно несколько).
- 10 мс CPU на запрос; ожидание ответов GitHub/Telegram в CPU не считается.
- KV/Durable Objects не нужны — дедупликация сделана через маркер в теле Issue.

## Если `workers.dev` не открывается из РФ

Telegram-серверы находятся за пределами РФ и до Cloudflare дотягиваются, поэтому
**webhook будет работать**. Проблема может быть только при ручной проверке URL из
домашней сети. Решения: VPN для проверки или свой домен
(Workers → Settings → **Domains & Routes** → Add custom domain).
