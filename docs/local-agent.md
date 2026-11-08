# Локальный агент цен (домашний ПК)

WB отдаёт GitHub-раннерам `403`, а headless-браузерам — `498`. Поэтому цены проверяет
**видимый Edge на домашнем ПК** через Playwright: домашний IP и полноценный браузер
проходят антибот.

Схема:

```
Windows Task Scheduler (каждые 2 часа)
   └─► node scripts/check-prices-local.mjs
         └─► Edge (Playwright) → страница товара WB
               └─► public/data/products.json + history.json
                     └─► git commit + push → приложение читает через GitHub API
```

## Что нужно

- Windows 10/11, Node.js 20+, установленный Microsoft Edge.
- Клон репозитория `price-radar`.
- ПК включён и пользователь залогинен (Edge — видимый браузер).
- Для push-уведомлений — VAPID-ключи (см. ниже). Без них цены обновляются, push пропускается.

## 1. Установка

```powershell
cd D:\Prog_dev\ai\price-radar
npm install
git config user.name "Price Radar"
git config user.email "actions@users.noreply.github.com"
```

`playwright-core` уже добавлен в `devDependencies`; отдельный браузер скачивать не нужно —
используется установленный Edge.

## 2. Первый запуск

```powershell
node scripts/check-prices-local.mjs
```

Что произойдёт:

1. Откроется окно Edge (свёрнутое). Оно само закроется через ~10–20 секунд.
2. Скрипт загрузит страницы товаров, обновит название, цену и историю. Используется отдельный профиль Edge ЦенРадара (`.local/edge-profile-priceradar` или существующий `.local/edge-profile`), не ваш обычный профиль браузера. Для первичного входа/проверки сессии: `npm run browser:login`.
3. Сделает коммит `data: цены (local)` и запушит его.
4. Лог: `logs/check-prices.log`.

Если окно не появляется или в логе `parse failed` — запустите с видимым окном:

```powershell
$env:PRICE_RADAR_MINIMIZED='0'; node scripts/check-prices-local.mjs
```

Первый запуск может показать капчу WB — решите её один раз, профиль сохранит cookies
в `.local/edge-profile`, дальше будет проходить автоматически.

## 3. Расписание (каждые 2 часа)

```powershell
$node = (Get-Command node).Source
# conhost --headless предотвращает мигание консольного окна при запуске
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless -- `"$node`" scripts/check-prices-local.mjs" -WorkingDirectory "D:\Prog_dev\ai\price-radar"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun
Register-ScheduledTask -TaskName "PriceRadarLocal" -Action $action -Trigger $trigger -Settings $settings -Description "ЦенРадар: локальная проверка цен WB" -Force
```

Проверить:

```powershell
Get-ScheduledTask -TaskName PriceRadarLocal | Get-ScheduledTaskInfo
```

Удалить:

```powershell
Unregister-ScheduledTask -TaskName PriceRadarLocal -Confirm:$false
```

Задача работает **только когда пользователь залогинен** (нужен GUI-браузер). Если ПК
спит/выключен — проверка пропускается; следующая попытка по расписанию. `-WakeToRun`
пытается разбудить ПК.

## 4. Push-уведомления

Скрипт отправляет Web Push, если в `.env` есть ключи:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Публичный ключ лежит в `public/data/config.json` (`vapidPublicKey`). Приватный ключ —
в GitHub Secrets (`VAPID_PRIVATE_KEY`) и локально недоступен. Если он у вас есть — добавьте
в `.env`. Если нет:

- можно оставить push отключённым (цены всё равно обновляются);
- либо сгенерировать новую пару `npm run vapid`, обновить `config.json` и GitHub-секреты,
  после чего на iPhone нужно заново включить push (подписка привязана к ключу).

## 5. Важно

- **Не запускайте одновременно** локальный скрипт и Actions `check-prices` — они будут
  конфликтовать за `public/data`. Расписание Actions отключено в `check-prices.yml`;
  ручной запуск используйте только при наличии `WB_PROXY_URL`.
- Скрипт делает `git pull --rebase --autostash` перед работой и retry при push.
- Lock-файл `.local/check-prices.lock` не даёт запустить два экземпляра.
- Папки `.local/` и `logs/` в `.gitignore`.
- Если WB снова начнёт блокировать профиль: удалите `.local/edge-profile` и запустите
  скрипт с `PRICE_RADAR_MINIMIZED=0`, чтобы пройти капчу заново.
- Ozon этим скриптом не покрывается — там нужен ручной ввод или отдельный прокси.

## 6. Проверка результата

После первого успешного запуска в `public/data/products.json` появятся название и цена,
в `history.json` — первая точка. В приложении на iPhone обновите страницу (потяните вниз).
