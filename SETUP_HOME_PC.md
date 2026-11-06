# Инструкция: OpenCode на домашнем ПК (ЦенРадар)

Этот документ описывает, как настроить OpenCode на домашнем компьютере, чтобы он мог выполнять те же задачи, что и в этой сессии — без дополнительных вопросов.

## 1. Установка OpenCode

1. Скачайте OpenCode для Windows: https://opencode.ai (или через winget: `winget install opencode`).
2. Установите и запустите.
3. При первом запуске выберите рабочую директорию — например, `C:\ai\PH` или любую пустую папку.

## 2. Клонирование репозитория

В терминале OpenCode (или в PowerShell):

```
cd C:\ai
git clone https://github.com/avovka0-spec/price-radar.git
cd price-radar
npm install
```

Репозиторий уже содержит весь код, скрипты и workflows. `npm install` поставит зависимости (Next.js, TypeScript, web-push).

## 3. Настройка GitHub-токена (для работы с репо)

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Generate new token (classic), срок 90 дней, галочки: **repo**, **workflow**.
3. В OpenCode создайте файл `.env` в корне проекта (или задайте переменные окружения):
   ```
   GH_TOKEN=ghp_ВАШ_ТОКЕН
   GH_OWNER=avovka0-spec
   GH_REPO=price-radar
   ```
4. OpenCode подхватит переменные при запуске из этой папки.

## 4. Как ставить задачи

### Способ A: через OpenCode (основной)

Откройте сессию в OpenCode, напишите задачу на русском. Агент:
- прочитает код репозитория;
- выполнит изменения;
- закоммитит и запушит;
- пришлёт отчёт в Telegram (через GitHub Actions ретранслятор).

### Способ B: через Telegram-бота (асинхронно)

1. Откройте бота **@opencodeOtchetBot** в Telegram.
2. Отправьте сообщение с задачей (например: «Добавь поддержку Ozon в воркер цен»).
3. Каждые 5 минут workflow `telegram-to-issues` опросит бота и создаст GitHub Issue с вашей задачей.
4. Когда вернётесь в OpenCode — скажите агенту: «Выполни задачи из Issues» — он прочитает Issues, выполнит и пришлёт отчёт в Telegram.

## 5. Как агент отправляет отчёты

Поскольку Telegram API недоступен напрямую из среды выполнения OpenCode, используется **ретранслятор через GitHub Actions**:

1. Агент создаёт файл с текстом отчёта.
2. Запускает workflow `telegram-notify` через GitHub API (workflow_dispatch).
3. Runner GitHub Actions (с полным интернетом) отправляет сообщение в Telegram Bot API.
4. Вы получаете отчёт в чате бота.

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
│   ├── check-prices.mjs    # воркер цен (запускается Actions)
│   ├── telegram-to-issues.mjs  # опрос бота → Issues
│   ├── gen-icons.mjs       # генерация иконок
│   └── generate-vapid.mjs  # генерация VAPID-ключей
├── .github/workflows/
│   ├── check-prices.yml    # cron каждые 2 часа
│   ├── deploy-pages.yml    # деплой на GitHub Pages
│   ├── telegram-notify.yml # ретранслятор отчётов
│   └── telegram-to-issues.yml  # задачи из Telegram
├── public/data/            # данные (products, history, config, offset)
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

- **WB** — открытый API `card.wb.ru`, работает из РФ и с CI (иногда 403 с зарубежных IP — тогда нужен прокси через секрет `WB_PROXY_URL`).
- **Ozon / AliExpress** — нет открытого API; цены вводятся вручную (как в xmix.pro) или через бэкенд с Playwright.
- **История цен** копится с момента добавления товара (ретроспектива недоступна).
- **Push на iPhone** работает только для PWA, установленной через «На экран Домой» (iOS 16.4+).
- **Токен приложения** (fine-grained, Contents: Read/Write) хранится в localStorage телефона, не в репозитории.

## 9. Если что-то не работает

- Проверьте Actions: https://github.com/avovka0-spec/price-radar/actions
- Логи воркера цен: Actions → check-prices → последний запуск.
- Если WB возвращает 403 — задайте секрет `WB_PROXY_URL` (мини-relay на RU VPS).
- Если Push не включается — проверьте, что VAPID-секреты заданы и приложение установлено на домашний экран.