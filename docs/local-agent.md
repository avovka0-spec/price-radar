# Локальный агент цен (домашний ПК)

GitHub-раннеры и headless-браузеры часто блокируются маркетплейсами (WB даёт 403/498, Ozon/Яндекс Маркет/AliExpress.ru могут показывать капчу/антибот). Поэтому цены и базовые метаданные обновляет **локальный агент** на домашнем ПК: `scripts/check-prices-local.mjs` через **Microsoft Edge** (Playwright, профиль ЦенРадара).

Поддерживаемые маркетплейсы (best-effort, с учётом антибот-ограничений): **WB, Ozon, Яндекс Маркет, AliExpress (aliexpress.ru)**.

Схема:

```
Windows Task Scheduler (по расписанию)
   └─► node scripts/check-prices-local.mjs
         └─► Edge (Playwright, профиль ЦенРадара) → карточки товаров
               └─► public/data/products.json + history.json
                     └─► git commit + push → приложение читает через GitHub API
```

## Что нужно

- Windows 10/11, Node.js 20+, установленный Microsoft Edge.
- Клон репозитория `price-radar`, `npm install`.
- ПК включён и пользователь залогинен (нужен GUI-контекст; окно Edge может быть смещено/минимизировано, не headless по умолчанию).
- Для WB/Ozon/ЯМ/Ali полезно быть залогиненным в отдельном профиле ЦенРадара: `npm run browser:login` (использует `.local/edge-profile-priceradar` или legacy `.local/edge-profile`).
- Для push-уведомлений — VAPID-ключи (см. ниже). Без них цены обновляются, push пропускается.

## 1. Установка

```powershell
cd D:\Prog_dev\ai\price-radar
npm install
git config user.name "Price Radar"
git config user.email "actions@users.noreply.github.com"
```

`playwright-core` используется с установленным Edge; отдельный браузер скачивать не нужно.

## 2. Запуск и проверка

```powershell
node scripts/check-prices-local.mjs
```

Полезные режимы (для диагностики/ограничения нагрузки и антибота):

```powershell
# Показать окно Edge
$env:PRICE_RADAR_MINIMIZED='0'; node scripts/check-prices-local.mjs

# Только один маркетплейс / пропустить проблемные
node scripts/check-prices-local.mjs --only-marketplace wb
node scripts/check-prices-local.mjs --only-marketplace ozon --limit 5
node scripts/check-prices-local.mjs --skip-marketplace ozon,ym,ali

# Задержка между товарами (мс). Для Ozon/ЯМ/Ali рекомендуется >= 4000.
node scripts/check-prices-local.mjs --delay-ms 5000

# Через переменные окружения:
# CHECK_MARKETPLACES=wb,ozon,ym,ali
# CHECK_ONLY_MARKETPLACE / CHECK_SKIP_MARKETPLACE
# CHECK_LIMIT=20
# CHECK_DELAY_MS=4500
```

Что делает скрипт:

1. `git pull --rebase --autostash origin main`.
2. Фильтрует товары по маркетплейсу/флагам, открывает карточки в Edge-профиле ЦенРадара.
3. Обновляет `lastCheckedAt`, а при успешном парсинге — цену/название/бренд/картинку и историю (`public/data/history.json`).
4. При падении цены относительно порога/уведомлений готовит push (если VAPID настроен).
5. Коммитит `public/data` и пушит (`data: цены (local)`).

Лог: `logs/check-prices.log`. Lock: `.local/check-prices.lock` (не даёт запустить два экземпляра).

## 3. Антибот-ограничения (важно)

- **WB**: видимый/смещённый Edge + домашний IP обычно проходят; headless может давать 498. При `parse failed`/капче запустите с `PRICE_RADAR_MINIMIZED=0` и пройдите проверку вручную в профиле.
- **Ozon / Яндекс Маркет / AliExpress.ru**: антибот строже, селекторы/разметка меняются. Агент работает *best-effort*: использует задержки, берёт цену/метаданные из видимых элементов/OG/title, при признаках капчи (`captcha`, `robot`, `доступ ограничен` и т.п.) пропускает товар и пишет причину в лог.
- Не гоняйте большие списки часто; начните с `--limit` и `--delay-ms 5000+`. При блокировках проверьте конкретный товар вручную через `npm run browser:login`.
- Скрипт **не** обходит защиту агрессивно; он полагается на обычный браузерный профиль и умеренный темп.

## 4. Расписание (каждые 2 часа)

```powershell
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless -- `"$node`" scripts/check-prices-local.mjs" -WorkingDirectory "D:\Prog_dev\ai\price-radar"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun
Register-ScheduledTask -TaskName "PriceRadarLocal" -Action $action -Trigger $trigger -Settings $settings -Description "ЦенРадар: локальная проверка цен (WB/Ozon/ЯМ/Ali)" -Force
```

Удалить: `Unregister-ScheduledTask -TaskName PriceRadarLocal -Confirm:$false`

Задача работает **только когда пользователь залогинен**.

## 5. Уведомления (Web Push и Telegram)

**Web Push** (PWA/iPhone) — в `.env`:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```
Публичный ключ — в `public/data/config.json` (`vapidPublicKey`). Если VAPID не задан, push пропускается.

**Telegram-алерты** при падении цены/достижении целевой (локальный агент, прямая отправка в Bot API) — в `.env` (gitignored, не коммитить токен):
```
TELEGRAM_PRICE_BOT_TOKEN=123456:ABC...   # токен бота (напр. @Price_radar_monitor_bot)
TELEGRAM_PRICE_CHAT_ID=1782021699        # куда слать (ваш личный chat_id)
```
Fallback: если `TELEGRAM_PRICE_*` не заданы, используются `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Сообщение отправляется сводкой за запуск при наличии событий (`notifyQueue`), как и push. Ошибки Telegram не останавливают проверку цен.

## 6. График цены в PWA

`components/Chart.tsx` строит график по `public/data/history.json` (до 180 дней): линия/область, дельта за период, средняя, отметки min/max, подписи осей, полые точки для цен, введённых вручную. При 1 точке показывается сводка вместо пустого графика. История копится с момента добавления товара — ретроспектива недоступна.

## 7. Важно

- **Не запускайте одновременно** локальный агент и Actions `check-prices` без явной необходимости — возможны конфликты в `public/data`. Расписание Actions обычно отключено/ручное.
- Скрипт делает `git pull --rebase --autostash` и retry при push; агент может авто-коммитить/пушить `public/data` после проверки.
- Папки `.local/` и `logs/` в `.gitignore`.
- Профиль Edge: по умолчанию `.local/edge-profile-priceradar` (fallback `.local/edge-profile`). `PRICERADAR_EDGE_PROFILE` переопределяет путь. Экспериментально: `PRICERADAR_BROWSER_HEADLESS=1` (может ухудшить прохождение антибота, особенно WB).
