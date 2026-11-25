# Настройка связки Telegram → GitHub Issues → OpenCode на новом ПК

Инструкция для коллеги: как поднять на другом Windows-ПК ту же связку, что работает сейчас в `price-radar`.

> Секреты (токены ботов, GitHub PAT, webhook secret) **не храните в чате и не коммитьте**. Передавайте их только через защищённый канал (менеджер паролей / личный секретный канал). В репозитории должны быть только `.env.example` и документация без реальных значений.

## Что уже настроено централизованно (обычно не нужно повторять)

Эти части общие для репозитория и уже работают, если вы подключаетесь к тому же `avovka0-spec/price-radar`:

| Компонент | Где живёт | Что делает |
|---|---|---|
| Telegram-бот | Telegram | Принимает сообщения от владельца |
| Cloudflare Worker `price-radar-tg` | Cloudflare | Принимает webhook от Telegram, создаёт GitHub Issue с меткой `telegram-task`, отвечает в Telegram |
| GitHub Actions `telegram-webhook` | `.github/workflows/telegram-webhook.yml` | Ручное управление webhook (`set/info/delete`) |
| GitHub Actions `telegram-notify` | `.github/workflows/telegram-notify.yml` | Ретранслятор статусов в Telegram; его вызывает `node scripts/notify-telegram.mjs` |
| GitHub Secrets | Settings → Secrets and variables → Actions | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, при необходимости `TELEGRAM_PRICE_BOT_TOKEN` |

Если нужно поднять такую же связку **с нуля в другом репозитории/с другим ботом**, см. раздел [«Поднять с нуля»](#поднять-с-нуля-другой-репозиторий--бот).

## Что нужно настроить на каждом новом ПК

На каждом ПК, который должен автоматически выполнять задачи из Telegram/Issues, настраивается локальная часть:

1. Доступ к репозиторию GitHub + `git push`.
2. OpenCode Desktop / `opencode-cli.exe`.
3. `.env` с `GH_TOKEN` (и при необходимости другими переменными).
4. Планировщик Windows, который каждые 5 минут запускает watcher.
5. Проверка, что watcher может читать Issues, запускать OpenCode и отправлять статусы.

## 1. Предварительные требования

- Windows 10/11, пользователь входит в систему обычным логином (Task Scheduler запускает задачу только когда пользователь залогинен).
- Установлены: [Git for Windows](https://git-scm.com/download/win), [Node.js LTS](https://nodejs.org/), [OpenCode Desktop](https://opencode.ai/).
- Есть доступ к GitHub-репозиторию `avovka0-spec/price-radar` (или вашему форку/копии).
- Есть GitHub Personal Access Token (PAT) для локальных скриптов.

### GitHub PAT для ПК

Для `scripts/notify-telegram.mjs` и `scripts/opencode-issues-watcher.mjs` нужен токен с доступом к репозиторию:

- **Classic PAT**: scopes `repo` и `workflow`. `workflow` нужен для основного пути `workflow_dispatch`; если его нет, скрипт попробует `repository_dispatch`, которому достаточно `repo`.
- **Fine-grained PAT**: доступ только к нужному репозиторию, права минимум **Issues: Read and write**, **Contents: Read and write**, **Actions: Read and write** (для dispatch/status, если используете этот путь), **Metadata: Read**.

Токен храните в `.env` на ПК или в переменной окружения. **Не вставляйте токен в документы, issues, скриншоты, логи.**

## 2. Клонирование репозитория

```powershell
git clone https://github.com/avovka0-spec/price-radar.git D:\Prog_dev\ai\price-radar
cd D:\Prog_dev\ai\price-radar
npm install
```

Проверьте, что `git push` работает от вашего пользователя:

```powershell
git remote -v
git status
```

Если используете HTTPS, настройте Git Credential Manager или credential helper. Watcher и OpenCode могут делать commit/push, поэтому доступ на запись обязателен.

## 3. Локальный `.env`

Создайте `.env` в корне репозитория по образцу `.env.example`:

```dotenv
GH_TOKEN=ghp_ВАШ_ТОКЕН
GH_OWNER=avovka0-spec
GH_REPO=price-radar
TELEGRAM_CHAT_ID=1782021699

# Опционально: модель для watcher'а (по умолчанию уже задана в скрипте)
# OPENCODE_ISSUES_MODEL=opencode-go/iceman-contributor-free

# Опционально: явный путь к opencode-cli.exe
# OPENCODE_CLI=C:\Users\<USER>\AppData\Roaming\ai.opencode.desktop\cli\<version>\opencode-cli.exe

# Опционально: таймаут одной задачи, мс (по умолчанию 1800000 = 30 мин)
# OPENCODE_ISSUES_TIMEOUT_MS=1800000
```

`.env` уже в `.gitignore` — не коммитьте его.

Проверка отправки статуса:

```powershell
node scripts/notify-telegram.mjs "Тест: настройка нового ПК"
```

Ожидаемый вывод: `sent via workflow_dispatch ...` или `sent via repository_dispatch ...`.
Если не сработало — проверьте `GH_TOKEN`, scopes/permissions и доступ к Actions в репозитории.

## 4. OpenCode на ПК

1. Установите OpenCode Desktop и войдите/настройте его как обычно.
2. Убедитесь, что CLI доступен. Watcher ищет его автоматически в:
   - `%APPDATA%\ai.opencode.desktop\cli\*\opencode-cli.exe`
   - `%LOCALAPPDATA%\Programs\ai.opencode.desktop\resources\opencode-cli.exe`
   - или по переменной `OPENCODE_CLI`.
3. Проверьте вручную:

```powershell
$cli = Join-Path $env:APPDATA "ai.opencode.desktop\cli"
Get-ChildItem $cli -Recurse -Filter opencode-cli.exe | Select-Object -First 1 -ExpandProperty FullName
```

4. При первом ручном запуске убедитесь, что OpenCode может работать в репозитории и что политика permissions/auto-approve вас устраивает. Watcher запускает OpenCode с `--auto`.

## 5. Проверка watcher'а вручную

Сначала dry-run — он не запускает OpenCode, только показывает, какую открытую задачу с меткой `telegram-task` возьмёт:

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/opencode-issues-watcher.mjs --dry-run
```

Затем обычный запуск (обработает **одну** самую старую открытую задачу):

```powershell
node scripts/opencode-issues-watcher.mjs
```

Полезные файлы:

- `.local/opencode-issues.json` — состояние/дедупликация (gitignored).
- `.local/opencode-issues.lock` — lock от параллельных запусков.
- `logs/opencode-issues.log` — общий лог watcher'а.
- `logs/opencode-issue-<N>.log` — полный лог OpenCode по Issue.

## 6. Автозапуск через Windows Task Scheduler

Зарегистрируйте задачу (по умолчанию каждые 5 минут):

```powershell
cd D:\Prog_dev\ai\price-radar
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-opencode-issues-task.ps1
```

Что делает скрипт:

- создаёт/обновляет задачу `OpenCodeTelegramIssues`;
- запускает её через `wscript.exe //nologo scripts\run-hidden.vbs ...`, чтобы не мигало окно консоли;
- ставит триггер «каждые 5 минут», `StartWhenAvailable`, работа на батарее разрешена;
- `MultipleInstances IgnoreNew` не даёт запускать второй watcher поверх первого.

Проверка:

```powershell
Get-ScheduledTaskInfo -TaskName OpenCodeTelegramIssues | Select-Object LastRunTime,NextRunTime,LastTaskResult
Get-Content .\logs\opencode-issues.log -Tail 30
```

Удалить задачу:

```powershell
Unregister-ScheduledTask -TaskName OpenCodeTelegramIssues -Confirm:$false
```

> Важно: задача рассчитана на режим «только когда пользователь залогинен». Если ПК выключен, спит или пользователь не вошёл — Issues останутся открытыми и будут обработаны после следующего успешного запуска.

## 7. Как проверить всю цепочку end-to-end

1. Отправьте в Telegram-бота короткую тестовую задачу, например: `Тест: ответь одним предложением, что связка работает`.
2. Бот/Worker должен ответить, что задача принята, и создать Issue с меткой `telegram-task`.
3. В течение ~5 минут watcher на ПК должен подхватить Issue.
4. В Telegram придут статусы «принял / готово / ошибка».
5. В Issue появится комментарий watcher'а и, при успехе, полный отчёт; Issue будет закрыт watcher'ом.

Диагностика:

- Cloudflare Worker logs — если Issue не создался.
- GitHub Actions `telegram-webhook` → `action=info` — если webhook неактивен.
- `logs/opencode-issues.log` и `logs/opencode-issue-N.log` — если Issue создался, но локально не обработался.
- `Get-ScheduledTaskInfo -TaskName OpenCodeTelegramIssues` — если задача планировщика не запускается.

## 8. Что важно знать коллеге

- **Один Issue за запуск.** Watcher берёт самую старую открытую `telegram-task`.
- **Не закрывайте Issue вручную во время обработки.** При успехе watcher сам комментирует и закрывает Issue.
- **Статусы.** AGENTS.md требует отправлять статусы в Telegram через `node scripts/notify-telegram.mjs "..."`. Не спамьте: начало, этапы при долгой задаче, финал/ошибка.
- **Секреты.** Не печатайте токены, не коммитьте `.env`, не вставляйте секреты в Issue/логи/скриншоты.
- **Авто-режим OpenCode.** `opencode run --auto` автоматически одобряет разрешения, не помеченные deny. Используйте на доверенном ПК и с понятной политикой OpenCode.
- **Конфликты.** Не запускайте вручную ту же задачу, которую сейчас обрабатывает watcher.
- **Модель.** По умолчанию watcher использует `OPENCODE_ISSUES_MODEL` или `opencode-go/iceman-contributor-free`. Для сложных задач можно временно задать другую модель в `.env`, но учитывайте лимиты/стоимость.

## Поднять с нуля (другой репозиторий / бот)

Нужно только если вы не подключаетесь к уже настроенному `price-radar`, а разворачиваете копию.

1. **Telegram-бот.** Создайте бота через @BotFather, получите токен.
2. **GitHub Secrets.** Добавьте `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET` (случайная строка, см. `docs/telegram-webhook.md`).
3. **Cloudflare Worker.** Задеплойте `cloudflare/telegram-webhook.js` по инструкции [`docs/telegram-webhook.md`](./telegram-webhook.md). Нужны секреты/vars: `GH_TOKEN`, `GH_OWNER`, `GH_REPO`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`.
4. **Webhook.** Запустите workflow `telegram-webhook` с `action=set` и URL Worker'а.
5. **Локальный ПК.** Выполните разделы 1–6 этой инструкции.
6. **Проверка.** Отправьте тестовое сообщение в бота, убедитесь, что создан Issue, watcher подхватил, статусы пришли.

## Полезные файлы в репозитории

- [`AGENTS.md`](../AGENTS.md) — правила для агента, формат статусов, поведение с `telegram-task`.
- [`docs/telegram-webhook.md`](./telegram-webhook.md) — настройка Cloudflare Worker и webhook.
- [`docs/opencode-issues.md`](./opencode-issues.md) — watcher, Task Scheduler, переменные окружения.
- [`scripts/opencode-issues-watcher.mjs`](../scripts/opencode-issues-watcher.mjs) — локальный watcher.
- [`scripts/register-opencode-issues-task.ps1`](../scripts/register-opencode-issues-task.ps1) — регистрация задачи планировщика.
- [`scripts/notify-telegram.mjs`](../scripts/notify-telegram.mjs) — отправка статусов в Telegram через GitHub Actions.
- [`cloudflare/telegram-webhook.js`](../cloudflare/telegram-webhook.js) — код Cloudflare Worker.
- [`cloudflare/wrangler.toml`](../cloudflare/wrangler.toml) — конфиг Wrangler.
- [`.env.example`](../.env.example) — шаблон локальных переменных.
