# Автоприём задач из Telegram → GitHub Issues → OpenCode (домашний ПК)

Схема:

```
Telegram (@opencodeOtchetBot)
   └─► Cloudflare Worker → GitHub Issue (label: telegram-task)
         └─► Windows Task Scheduler "OpenCodeTelegramIssues" (каждые 5 мин)
               └─► scripts/opencode-issues-watcher.mjs
                     └─► opencode-cli run --auto (D:\Prog_dev\ai\price-radar)
                           ├─► правки + git commit/push (если нужно)
                           ├─► Telegram статусы (notify-telegram.mjs)
                           └─► комментарий + закрытие Issue
```

Ручная команда «выполни задачи из Issues» больше не нужна: watcher подхватывает новые
Issues автоматически, пока ПК включён и пользователь залогинен.

## Требования

- OpenCode Desktop установлен; CLI доступен (автопоиск в `%APPDATA%\ai.opencode.desktop\cli\*\opencode-cli.exe`).
- Репозиторий: `D:\Prog_dev\ai\price-radar`, `git push` работает (GCM / учётные данные).
- `GH_TOKEN` доступен скрипту: из `.env`/окружения или через `git credential fill` (как у других скриптов).
- Задача планировщика работает **только при вошедшем пользователе** (нужен OpenCode background service/GUI-контекст).

## Файлы

- `scripts/opencode-issues-watcher.mjs` — watcher.
- `.local/opencode-issues.json` — состояние/дедупликация (gitignored).
- `.local/opencode-issues.lock` — защита от параллельных запусков.
- `logs/opencode-issues.log` — общий лог watcher'а.
- `logs/opencode-issue-<N>.log` — вывод OpenCode по конкретному Issue.

## Ручной запуск / проверка

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/opencode-issues-watcher.mjs --dry-run   # только показать, что будет обработано
node scripts/opencode-issues-watcher.mjs             # обработать одну самую старую задачу
```

## Планировщик Windows

Создать/обновить (уже настроено на этом ПК как `OpenCodeTelegramIssues`):

```powershell
$node = (Get-Command node).Source
# conhost --headless предотвращает мигание консольного окна каждые 5 минут
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless -- `"$node`" scripts/opencode-issues-watcher.mjs" -WorkingDirectory "D:\Prog_dev\ai\price-radar"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "OpenCodeTelegramIssues" -Action $action -Trigger $trigger -Settings $settings -Description "ЦенРадар/OpenCode: приём telegram-task Issues и запуск opencode" -Force
```

Проверка:

```powershell
Get-ScheduledTaskInfo -TaskName OpenCodeTelegramIssues | Select-Object LastRunTime,NextRunTime,LastTaskResult
Get-Content logs\opencode-issues.log -Tail 30
```

Удалить:

```powershell
Unregister-ScheduledTask -TaskName OpenCodeTelegramIssues -Confirm:$false
```

## Настройки

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | git credential fill | Доступ к GitHub Issues/API |
| `GH_OWNER` / `GH_REPO` | `avovka0-spec` / `price-radar` | Репозиторий |
| `TELEGRAM_CHAT_ID` | `1782021699` | Куда слать статусы |
| `OPENCODE_CLI` | автопоиск | Путь к `opencode-cli.exe` |
| `OPENCODE_ISSUES_MODEL` | `opencode-go/iceman-contributor-free` | Модель для `opencode run` |
| `OPENCODE_ISSUES_TIMEOUT_MS` | `1800000` (30 мин) | Таймаут на задачу |

Модель по умолчанию — бесплатная/доступная, чтобы автоматика не упиралась в лимиты
подписки. Для сложных задач можно задать более сильную модель в `.env`.

## Поведение и ограничения

- Обрабатывается **одна самая старая** открытая задача за запуск (5–30 мин окна, проще логи/таймауты).
- Повторная обработка: `done` — пропускается; `running` старше 2 часов — считается зависшей; `failed` — до 2 попыток в сутки.
- При успехе (exit 0, без таймаута) watcher комментирует и **закрывает** Issue. При ошибке Issue остаётся открытым.
- Watcher отправляет статусы «принял / готово / ошибка». В Telegram приходит итог + хвост отчёта; **полный отчёт** (очищенный вывод OpenCode, при необходимости разбитый на части) публикуется в комментариях Issue в `<details>`. Локальный полный лог: `logs/opencode-issue-N.log`. Сам OpenCode, следуя `AGENTS.md`, тоже может отправлять статусы — это нормально, если не злоупотреблять.
- OpenCode запускается с `--auto` (авто-одобрение разрешений, не помеченных deny). Убедитесь, что конфиг OpenCode и права репозитория вам подходят.
- ПК выключен/спит/пользователь не залогинен — задача не выполнится, но Issue останется открытым и будет обработан после следующего успешного запуска.
- Конфликт с ручной работой: не запускайте watcher и ручное выполнение той же задачи одновременно.
