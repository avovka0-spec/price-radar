# Инструкция: OpenCode на домашнем ПК (ЦенРадар)

Этот документ описывает, как настроить OpenCode на домашнем компьютере, чтобы он мог
выполнять те же задачи, что и в этой сессии — без дополнительных вопросов.

## 0. Что понадобится

- Windows 10/11 (x64 или ARM64).
- **Node.js 20 LTS** или новее (Next.js 14 требует Node ≥ 18.17).
- **Git for Windows** (вместе с ним ставится Git Credential Manager).
- Доступ к GitHub-аккаунту `avovka0-spec` и репозиторию `price-radar`.

## 1. Установка OpenCode

1. Скачайте установщик OpenCode для Windows: https://opencode.ai (Desktop, Windows x64/ARM64).
2. Установите и запустите.
3. При первом запуске выберите рабочую директорию — `C:\ai` (репозиторий клонируем туда).

Про CLI: `npm install -g @opencode/cli`. Официально менеджеры пакетов Windows для OpenCode V2
не поддерживаются, а winget-пакет может отставать по версии. Если всё же нужен winget —
`winget install SST.OpenCodeDesktop`, но установщик с opencode.ai надёжнее.

## 2. Клонирование репозитория

В терминале OpenCode (или в PowerShell):

```
cd C:\ai
git clone https://github.com/avovka0-spec/price-radar.git
cd price-radar
copy .env.example .env
npm ci
```

`npm ci` ставит зависимости строго по `package-lock.json` (Next.js, TypeScript, web-push).
Если `package-lock.json` обновился — используйте `npm install`.

## 3. Настройка GitHub-токена

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Generate new token (classic), срок 90 дней, галочки: **repo**, **workflow**.
3. Откройте `.env` в корне проекта (он создан из `.env.example`) и заполните:

```
GH_TOKEN=ghp_ВАШ_ТОКЕН
GH_OWNER=avovka0-spec
GH_REPO=price-radar
TELEGRAM_CHAT_ID=1782021699
```

4. `.env` уже добавлен в `.gitignore` — в публичный репозиторий он не попадёт.
   **Никогда не коммитьте `.env` и не вставляйте токен в Issues/чат.**

> **Важно:** это токены для OpenCode и Worker'а. Приложению на iPhone нужен **отдельный**
> fine-grained токен с правом **Contents: Read and write** — он вводится в настройках
> приложения и хранится в localStorage. Токен Worker'а (Issues) для приложения не подходит.

Если OpenCode не видит переменные из `.env`, задайте их в системе и перезапустите OpenCode:

```
setx GH_TOKEN "ghp_ВАШ_ТОКЕН"
setx GH_OWNER "avovka0-spec"
setx GH_REPO "price-radar"
setx TELEGRAM_CHAT_ID "1782021699"
```

Скрипт `scripts/notify-telegram.mjs` читает `.env` сам, даже если OpenCode его не загрузил.

**Git push:** используется Git Credential Manager. При первом `git push` откроется браузер —
войдите под `avovka0-spec`. Если менеджер не настроен:

```
git config --global credential.helper manager
```

## 4. Как ставить задачи

### Способ A: через OpenCode (основной)

Откройте сессию в OpenCode, напишите задачу на русском. Агент:

- прочитает код репозитория;
- выполнит изменения;
- закоммитит и запушит;
- пришлёт статусы в Telegram (начало, этапы, завершение/ошибка) — см. раздел 5.

### Способ B: через Telegram-бота (асинхронно, мгновенно)

1. Откройте бота **@opencodeOtchetBot** в Telegram.
2. Отправьте сообщение с задачей (например: «Добавь поддержку Ozon в воркер цен»).
3. Cloudflare Worker принимает webhook от Telegram и сразу создаёт GitHub Issue с меткой
   `telegram-task`. В ответ бот присылает «✅ Задача принята: Issue #N».
4. Когда вернётесь в OpenCode — скажите агенту: «Выполни задачи из Issues» — он прочитает
   Issues, выполнит и пришлёт отчёт в Telegram.

Настройка webhook: **[docs/telegram-webhook.md](docs/telegram-webhook.md)** (20–30 минут,
бесплатно). Пока webhook не настроен, можно запускать `telegram-to-issues` вручную.
После включения webhook polling отключён: Telegram не разрешает webhook и `getUpdates`
одновременно.

## 5. Статусы и отчёты в Telegram

Агент отправляет статусы через ретранслятор GitHub Actions (из OpenCode Telegram API
напрямую недоступен):

```bash
node scripts/notify-telegram.mjs "🚀 Начал: <задача>"
node scripts/notify-telegram.mjs "⏳ Этап: <что сделано>"
node scripts/notify-telegram.mjs "✅ Готово: <итог, commit, ссылка>"
node scripts/notify-telegram.mjs "❌ Ошибка: <причина и следующий шаг>"
```

Правила для агента лежат в `AGENTS.md` — OpenCode читает этот файл автоматически.
Скрипт сам читает `.env`, поэтому дополнительные настройки не нужны.

Как это работает:

1. Скрипт вызывает GitHub API (`workflow_dispatch`, fallback — `repository_dispatch`).
2. Workflow `telegram-notify` на runner'е отправляет сообщение в Telegram Bot API.
3. Вы получаете статус в чате бота.

Проверка связи:

```bash
node scripts/notify-telegram.mjs "✅ Тест: связь с ботом работает"
```

Секреты (уже настроены в репозитории):

- `TELEGRAM_BOT_TOKEN` — токен бота
- `TELEGRAM_CHAT_ID` — ваш chat_id (1782021699)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — для push-уведомлений

## 6. Структура проекта

```
price-radar/
├── app/                    # Next.js PWA (UI)
│   ├── page.tsx            # главная страница, карточки, детали
│   └── globals.css         # стили (iOS-like)
├── components/Chart.tsx    # SVG-график цены
├── lib/                    # wb.ts (парсеры ссылок), github.ts (Contents API), push.ts
├── scripts/
│   ├── check-prices.mjs    # воркер цен для Actions (ручной запуск)
│   ├── check-prices-local.mjs  # локальный воркер цен на домашнем ПК
│   ├── opencode-issues-watcher.mjs  # автоприём telegram-task Issues → OpenCode
│   ├── wb-import-favorites.mjs # локальный импорт избранного WB (MVP, .local/)
│   ├── wb-import-orders.mjs    # локальный импорт заказов WB (MVP, .local/)
│   ├── wb-import-personal-prices.mjs # снимок цен из залогиненного профиля WB
│   ├── wb-relay.mjs        # WB-прокси для запуска на RU VPS
│   ├── telegram-to-issues.mjs  # опрос бота → Issues
│   ├── notify-telegram.mjs # статусы/отчёты агента → Telegram
│   ├── gen-icons.mjs       # генерация иконок
│   └── generate-vapid.mjs  # генерация VAPID-ключей
├── cloudflare/
│   └── telegram-webhook.js # Worker: Telegram webhook → GitHub Issue
├── docs/
│   ├── telegram-webhook.md # пошаговая настройка Cloudflare Worker
│   ├── wb-proxy.md         # WB-прокси на RU VPS
│   ├── local-agent.md      # локальный агент цен на домашнем ПК
│   ├── opencode-issues.md  # автоприём telegram-task Issues на ПК
│   └── marketplace-account-import.md # локальный импорт ЛК маркетплейсов (MVP)
├── .github/workflows/
│   ├── check-prices.yml    # cron каждые 2 часа
│   ├── deploy-pages.yml    # деплой на GitHub Pages
│   ├── telegram-notify.yml # ретранслятор статусов/отчётов
│   ├── telegram-to-issues.yml  # polling (ручной fallback)
│   └── telegram-webhook.yml    # setWebhook / deleteWebhook / getWebhookInfo
├── public/data/            # данные (products, history, config, telegram-offset)
├── AGENTS.md               # правила агента (в т.ч. статусы в Telegram)
├── .env.example            # шаблон переменных (сам .env не коммитится)
└── README.md
```

## 7. Быстрый старт (проверка)

```
cd C:\ai\price-radar
npm run build                    # сборка
npm run dev                      # локальный сервер на :3000
# или
npm run build && npx serve out   # статический превью
```

Демо-режим: откройте `http://localhost:3000/?demo`.

## 8. Важные нюансы

- **WB / Ozon / Яндекс Маркет / AliExpress (aliexpress.ru)** — GitHub-раннеры и headless-браузеры часто блокируются (WB 403/498, остальные — антибот/капча). Цены и базовые метаданные обновляет **локальный агент на домашнем ПК** через Edge/Playwright (best-effort, с троттлингом и пропуском при капче): [docs/local-agent.md](docs/local-agent.md). Расписание Actions `check-prices` обычно отключено/ручное.
  Альтернатива для WB на сервере — RU-релей `WB_PROXY_URL` ([docs/wb-proxy.md](docs/wb-proxy.md)).
- **Ozon / Яндекс Маркет / AliExpress** — официального открытого API для потребительских цен нет; локальный агент делает best-effort парсинг карточек в залогиненном/обычном профиле Edge. При блокировке цену можно ввести/скорректировать вручную в PWA.
- **История цен** копится с момента добавления товара (ретроспектива недоступна).
- **Push на iPhone** работает только для PWA, установленной через «На экран Домой» (iOS 16.4+).
- **Токен приложения** (fine-grained, Contents: Read/Write) хранится в localStorage телефона,
  не в репозитории.
- **Задачи из Telegram** идут через webhook Cloudflare Worker — мгновенно. Локальный watcher
  `OpenCodeTelegramIssues` (каждые 5 мин) автоматически запускает OpenCode по открытым
  `telegram-task` Issues: [docs/opencode-issues.md](docs/opencode-issues.md). Для скрытого запуска
  по расписанию используйте `scripts/register-opencode-issues-task.ps1` (без `conhost --headless`,
  который на некоторых ПК вызывает мигание/перезагрузку мониторов). Polling `telegram-to-issues`
  оставлен как ручной откат; расписание отключено.
- **`public/data/telegram-offset.json`** нужен только для polling. При работе через
  webhook дедупликация идёт по маркеру `telegram-update-id` в теле Issue.

## 9. Если что-то не работает

- Проверьте Actions: https://github.com/avovka0-spec/price-radar/actions
- Логи воркера цен: Actions → check-prices → последний запуск.
- Статусы не приходят: `node scripts/notify-telegram.mjs "тест"` → Actions → telegram-notify.
  Если 403 — у токена нет scope `workflow`, добавьте его или используйте fallback
  `repository_dispatch` (нужен scope `repo`).
- **401 на iPhone** — токен приложения недействителен или отозван. Создайте fine-grained
  токен с **Contents: Read and write** и вставьте его в настройках приложения; там же есть
  кнопка «Проверить токен». Чтение публичного репозитория теперь работает и без токена.
- **Цена и название не обновляются** — проверьте `logs/check-prices.log` локального агента.
  Если там `parse failed`/`498`/`antibot`, запустите с видимым окном (`PRICE_RADAR_MINIMIZED=0`) или точечно: `node scripts/check-prices-local.mjs --only-marketplace <wb|ozon|ym|ali> --limit 1 --delay-ms 5000`, пройдите капчу в профиле ЦенРадара (`npm run browser:login`). Подробности: [docs/local-agent.md](docs/local-agent.md).
- `git push` просит пароль — настройте Git Credential Manager и войдите под `avovka0-spec`.
- Issues из Telegram не появляются: Actions → `telegram-webhook` → `action=info` (проверьте
  `last_error_message`), логи Worker в Cloudflare, совпадение `WEBHOOK_SECRET` и
  `TELEGRAM_WEBHOOK_SECRET`. Инструкция: `docs/telegram-webhook.md`.
- Если WB возвращает 403 — задайте секрет `WB_PROXY_URL` (мини-relay на RU VPS,
  см. [docs/wb-proxy.md](docs/wb-proxy.md)).
- Если Push не включается — проверьте, что VAPID-секреты заданы и приложение установлено
  на домашний экран.
