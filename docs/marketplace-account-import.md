# Импорт из личного кабинета маркетплейсов (локально, MVP)

Цель: подтягивать избранное/заказы/персональные цены из ЛК маркетплейсов **без бэкенда**,
используя локальный браузерный профиль на вашем ПК. Подходит для личного использования (один пользователь).

## Принципы безопасности

- **Чувствительные данные ЛК (заказы, персональные скидки, детали аккаунта) хранятся только локально** в `.local/marketplaces/` — папка gitignored, в GitHub не коммитится.
- Скрипты **не сохраняют и не запрашивают логин/пароль маркетплейса** в репозитории/приложении. Вход выполняете вы сами в открывшемся браузере (2FA/капча — вручную).
- В `public/data/products.json` добавляйте только то, что хотите отслеживать (обычно SKU/ссылка/название/цена). Не коммитьте выгрузки заказов/ЛК.
- Автоматизация авторизованного кабинета может зависеть от вёрстки/антибот-защиты маркетплейса; скрипты best-effort.

## Отдельный профиль Edge для ЦенРадара

Все локальные скрипты используют **изолированный профиль Edge** (Playwright user-data-dir), не ваш обычный профиль браузера:
- по умолчанию: `.local/edge-profile-priceradar` (если есть старый `.local/edge-profile` — используется он для совместимости);
- переопределение: `PRICERADAR_EDGE_PROFILE` в `.env` или окружении.

Первичная настройка (войти в маркетплейсы один раз):
```powershell
npm run browser:login
# или все площадки сразу:
node scripts/priceradar-browser-login.mjs --all
```

## Запуск Edge без мелькания окна

WB/некоторые сайты блокируют настоящий `headless` (ошибка 498), поэтому фоновые запуски используют **видимый headed-режим, но окно убрано за пределы экрана** (`--window-position=-32000,-32000 --start-minimized`). Это уменьшает визуальный шум, но на некоторых конфигурациях Windows может быть краткий эффект.

- `--headed` у скриптов импорта — открыть окно нормально (для входа/отладки).
- `PRICE_RADAR_MINIMIZED=0` — показать окно у `check-prices-local.mjs`.
- `PRICERADAR_BROWSER_HEADLESS=1` — **экспериментально**: настоящий headless; WB может вернуть 498. Используйте только если проверили, что ваш сценарий работает.

## Текущий статус

| Маркетплейс | Сценарий | Статус |
|---|---|---|
| WB | Избранное | MVP: `scripts/wb-import-favorites.mjs` |
| WB | Заказы | MVP: `scripts/wb-import-orders.mjs` (best-effort, локально) |
| WB | Персональные цены/скидки | MVP: `scripts/wb-import-personal-prices.mjs` (снимок цен из залогиненного профиля) |
| Ozon | избранное/заказы/скидки | планируется |
| Яндекс Маркет | избранное/заказы/скидки | планируется |
| AliExpress | избранное/заказы/скидки | планируется |

## WB: импорт избранного

Требования: Node.js, `playwright-core`, установленный Edge. Используется persistent profile `.local/edge-profile` (как у `check-prices-local.mjs`).

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/wb-import-favorites.mjs --headed --add-candidates
# или
npm run import:wb:favorites -- --headed --add-candidates
```

Что делает:
1. Открывает видимый Edge и страницу `https://www.wildberries.ru/lk/favorites`.
2. Ждёт до 90 секунд — если WB покажет вход, войдите вручную.
3. Пытается извлечь товары (SKU, ссылка, название, цена, картинка) из DOM.
4. Сохраняет локально:
   - `.local/marketplaces/wb/favorites-<timestamp>.json`
   - `.local/marketplaces/wb/favorites-<timestamp>.csv`
   - `.local/marketplaces/wb/favorites-latest.json`
5. С `--add-candidates` создаёт список SKU, которых нет в `public/data/products.json`.

Скрипт **не изменяет** `products.json`, **не делает** `git commit/push`. Добавление выбранных SKU — отдельный осознанный шаг.

## WB: импорт заказов (MVP)

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/wb-import-orders.mjs --headed --scrolls 12
# архив: --url https://www.wildberries.ru/lk/myorders/archive
# или: npm run import:wb:orders -- --headed
```

Скрипт открывает раздел заказов, ждёт/прокручивает страницу и сохраняет извлечённые блоки в `.local/marketplaces/wb/orders-*.json|csv` и `orders-latest.json`. Это **best-effort**: WB часто меняет вёрстку. Заказы — чувствительные данные, не коммитить.

## WB: персональные цены/скидки (MVP)

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/wb-import-personal-prices.mjs --from-favorites-latest --headed
# или из отслеживаемых товаров: --from-products --limit 20
# или явный список: --skus 1545780372,1704280114
# npm: npm run import:wb:prices -- --from-products --limit 20
```

Скрипт открывает карточки товаров в вашем залогиненном профиле и сохраняет снимок видимых цен/подсказок скидок в `.local/marketplaces/wb/personal-prices-*.json|csv`. Используйте для сравнения с публичной ценой трекера; автоматически менять `products.json` скрипт не должен.

## Следующие шаги (план)

1. Улучшить парсинг WB (избранное/заказы/цены) по реальным экспортам/DOM-снимкам после ваших прогонов.
2. Ozon / Яндекс Маркет / AliExpress: отдельные адаптеры; для Ozon/ЯМ ожидать больше антибот-ограничений.
3. Общий CLI: `import --marketplace wb --kind favorites|orders|prices`.
4. Интеграция с приложением: безопасный локальный поток «импорт → выбор → добавить в трекинг» (без публикации данных ЛК).
5. Нормализация «персональная цена vs публичная цена» в модели товара (отдельное поле/источник, без утечки ЛК в публичные данные).

## Если извлечение пустое

- Убедитесь, что вошли в WB и страница избранного реально открыта.
- Запустите с `--headed` и дождитесь полной загрузки.
- WB мог изменить вёрстку — обновите селекторы/логику в `scripts/wb-import-favorites.mjs`.
- Проверьте `debug` в `favorites-latest.json`.