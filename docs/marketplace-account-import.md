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
| Ozon | избранное/заказы/скидки | MVP (best-effort): `scripts/ozon-import-*.mjs`. Антибот/вёрстка часто меняются — возможна донастройка селекторов по `*-latest.json`/`debug`. |
| Яндекс Маркет | избранное/заказы/скидки | MVP (best-effort): `scripts/ym-import-*.mjs`. Возможны SmartCaptcha/антибот и смена URL разделов — используйте `--headed` и при необходимости `--url`; для тюнинга пришлите обезличенный `*-latest.json`/`debug`. |
| AliExpress | избранное/заказы/скидки | MVP (best-effort): `scripts/ali-import-*.mjs`. Высокая вероятность антибот/капчи/смены URL — используйте `--headed`, при необходимости `--url` (ваш wishlist/заказы), для тюнинга пришлите обезличенный `*-latest.json`/`debug`. |

Общий CLI:
```powershell
node scripts/import.mjs -m ozon -k favorites --headed
node scripts/import.mjs -m ym -k favorites --headed   # wishlist: --url .../my/wishlist
node scripts/import.mjs -m ali -k favorites --headed  # при смене URL: --url <ваш wishlist>
node scripts/import.mjs -m ali -k orders --headed --scrolls 8
node scripts/import.mjs -m ali -k prices --from-favorites-latest --headed
node scripts/import.mjs -m <wb|ozon|ym|ali> -k normalize
npm run import -- -m ali -k favorites --headed
```

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

## Нормализация «публичная vs персональная» цена (WB/Ozon/ЯМ/Ali MVP)

```powershell
# после снятия снимка персональных цен:
node scripts/normalize-prices.mjs --marketplace wb
node scripts/normalize-prices.mjs --marketplace ozon
node scripts/normalize-prices.mjs --marketplace ym
node scripts/normalize-prices.mjs --marketplace ali
# или через общий CLI:
node scripts/import.mjs -m <wb|ozon|ym|ali> -k normalize
npm run normalize:prices
```

Читает `public/data/products.json` (публичный трекинг) и `.local/marketplaces/<marketplace>/personal-prices-latest.json`, сохраняет сравнение **только** в `.local/marketplaces/normalized-prices-*.json|csv` (`normalized-prices-latest.json`). Ничего не пишет в `public/data` и не коммитит — персональные цены ЛК не должны попадать в публичные данные.

## WB: персональные цены/скидки (MVP)

```powershell
cd D:\Prog_dev\ai\price-radar
node scripts/wb-import-personal-prices.mjs --from-favorites-latest --headed
# или из отслеживаемых товаров: --from-products --limit 20
# или явный список: --skus 1545780372,1704280114
# npm: npm run import:wb:prices -- --from-products --limit 20
```

Скрипт открывает карточки товаров в вашем залогиненном профиле и сохраняет снимок видимых цен/подсказок скидок в `.local/marketplaces/wb/personal-prices-*.json|csv`. Используйте для сравнения с публичной ценой трекера; автоматически менять `products.json` скрипт не должен.

## Ozon: импорт ЛК (MVP, best-effort)

Используйте **тот же профиль Edge ЦенРадара** (`npm run browser:login`) и войдите в Ozon вручную (антибот/капча возможны). Все результаты — только в `.local/marketplaces/ozon/` (gitignored).

```powershell
# избранное
node scripts/import.mjs -m ozon -k favorites --headed
npm run import:ozon:favorites -- --headed

# заказы (список; при необходимости укажите --url)
node scripts/import.mjs -m ozon -k orders --headed --scrolls 8
npm run import:ozon:orders -- --headed

# персональные цены (по избранному/трекеру/списку)
node scripts/import.mjs -m ozon -k prices --from-favorites-latest --headed
node scripts/import.mjs -m ozon -k prices --from-products --limit 20 --headed
node scripts/import.mjs -m ozon -k prices --urls https://www.ozon.ru/product/... --headed
```

MVP использует эвристики DOM/ссылок `/product/<id>` и может требовать донастройки после реального прогона. Для тюнинга пришлите **обезличенный** фрагмент `.local/marketplaces/ozon/*-latest.json` (без персональных данных, которые не хотите раскрывать) и/или поле `debug`/`rawText`.

## Яндекс Маркет: импорт ЛК (MVP, best-effort)

Используйте **профиль Edge ЦенРадара** (`npm run browser:login`). Возможны SmartCaptcha/антибот — запускайте с `--headed` и при необходимости пройдите проверку вручную. Если раздел избранного у вас по другому URL, укажите `--url`. Результаты — только в `.local/marketplaces/ym/` (gitignored).

```powershell
# избранное / wishlist
node scripts/import.mjs -m ym -k favorites --headed
node scripts/import.mjs -m ym -k favorites --headed --url https://market.yandex.ru/my/wishlist
npm run import:ym:favorites -- --headed

# заказы
node scripts/import.mjs -m ym -k orders --headed --scrolls 8
npm run import:ym:orders -- --headed

# персональные цены (лучше передавать явные URL карточек или --from-favorites-latest)
node scripts/import.mjs -m ym -k prices --from-favorites-latest --headed
node scripts/import.mjs -m ym -k prices --from-products --limit 20 --headed
node scripts/import.mjs -m ym -k prices --urls "https://market.yandex.ru/product--.../123" --headed
```

MVP использует эвристики `/product--.../<id>`, `/card/.../<id>`, цены в ₽; `debug.antibotHint/loginHint` помогут понять причину пустого результата. Для тюнинга пришлите обезличенный фрагмент `.local/marketplaces/ym/*-latest.json` (или `debug`).

## AliExpress / aliexpress.ru: импорт ЛК (MVP, best-effort)

Для России используйте **aliexpress.ru** (вы уточнили). AliExpress часто показывает капчу/антибот и меняет URL/разметку, поэтому **обязательно указывайте `--url` вашего фактического раздела**, если дефолт не совпадает. Используйте профиль Edge ЦенРадара, `--headed`. Результаты — только в `.local/marketplaces/ali/` (gitignored).

```powershell
# wishlist / избранное (подставьте ВАШ URL из адресной строки после входа)
node scripts/import.mjs -m ali -k favorites --headed --url "https://aliexpress.ru/<ваш-wishlist-путь>"
# дефолтный URL скрипта (может не совпасть с вашим аккаунтом):
node scripts/import.mjs -m ali -k favorites --headed

# заказы
node scripts/import.mjs -m ali -k orders --headed --url "https://aliexpress.ru/<ваш-orders-путь>" --scrolls 8

# персональные цены (в ₽, если страница показывает RUB)
node scripts/import.mjs -m ali -k prices --from-favorites-latest --headed
node scripts/import.mjs -m ali -k prices --urls "https://aliexpress.ru/item/1234567890.html" --headed
```

Для тюнинга пришлите обезличенный фрагмент `.local/marketplaces/ali/*-latest.json` (`debug`, `sourceUrl`, 1–2 `items[]`/`orders[]`).

## Безопасный локальный поток: импорт → выбор → добавить в трекинг

Есть **локальный UI** (удобно) и CLI. Оба работают **только локально**: читают `.local/marketplaces/<marketplace>/` и изменяют **только** `public/data/products.json` (список товаров для трекинга). **Не делают** `git commit/push`. **Не копируют** избранное/заказы/`rawText`/персональные цены ЛК.

### Локальный UI (рекомендуется)
```powershell
cd D:\Prog_dev\ai\price-radar
npm run ui
# или: node scripts/import-ui.mjs --open
# или: node scripts/import.mjs -m ozon -k ui --open
# порт: --port 3847 (по умолчанию)
```
Открывает страницу на `http://127.0.0.1:3847/` (только localhost). Выберите маркетплейс/источник, загрузите кандидатов (те, кого ещё нет в `products.json`), отметьте нужные и нажмите «Добавить выбранные в трекинг». Опция «взять цену из импорта как начальную» выключена по умолчанию.

### CLI
```powershell
# 1) Сначала импорт избранного (данные остаются в .local/)
node scripts/import.mjs -m ozon -k favorites --headed --add-candidates

# 2) Посмотреть кандидатов (dry-run, ничего не меняет)
node scripts/import.mjs -m ozon -k add --dry-run

# 3) Добавить выбранное
node scripts/import.mjs -m ozon -k add --all --dry-run              # проверка
node scripts/import.mjs -m ozon -k add --skus ozon:851822112,ozon:1147653759
node scripts/import.mjs -m ozon -k add --indexes 1,2,5
node scripts/import.mjs -m ozon -k add --pick                        # интерактивно
# Опционально: --with-price — взять видимую цену из импорта как начальную currentPrice.
```

После добавления проверьте `git diff -- public/data/products.json`. В репозиторий попадут только поля трекинга (SKU/URL/название/маркетплейс/настройки), аналогично ручному добавлению в PWA. Историю цен и актуальную цену подтянет локальный агент/проверка цен (или ручной ввод в приложении).

Поддерживаются `wb|ozon|ym|ali` (маркетплейс в products: `wb`/`ozon`/`ym`/`ali`; SKU для Ozon/ЯМ/Ali — префиксный формат, например `ozon:123`, совместимый с парсером ссылок).

## Следующие шаги (план)

1. **Тюнинг по реальным прогонам**: донастройка парсеров по обезличенным `*-latest.json`/`debug` (ЯМ избранное/заказы/цены после фиксов, AliExpress.ru заказы по URL архива, при необходимости Ozon).
2. **Улучшение PWA-интеграции**: парсинг ссылок/метаданные Яндекс Маркета и AliExpress в веб-приложении (частично добавлено распознавание YM-ссылок), UX для товаров без авто-проверки цены, при необходимости локальный helper/UI (без бэкенда) поверх `add-to-tracking`.
3. При необходимости: локальный отчёт/UI сравнения «публичная vs персональная» цена, без записи персональных цен в `public/data`.

## Если извлечение пустое

- Убедитесь, что вошли в WB и страница избранного реально открыта.
- Запустите с `--headed` и дождитесь полной загрузки.
- WB мог изменить вёрстку — обновите селекторы/логику в `scripts/wb-import-favorites.mjs`.
- Проверьте `debug` в `favorites-latest.json`.