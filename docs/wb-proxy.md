# WB-прокси для воркера цен

GitHub Actions запускается за пределами РФ, а `card.wb.ru` отдаёт таким IP **403**.
В логе `check-prices` это выглядит так:

```
! WB_PROXY_URL не задан — GitHub runner может получить 403 от WB
WB 403 для 1545780372: нужен WB_PROXY_URL (RU-релей)
no card: 1545780372
```

Поэтому воркер ходит в WB через маленький relay на сервере с российским IP.

## Что нужно

- VPS/сервер с российским IP и Node.js 20+.
- Желательно домен и HTTPS (Caddy/Nginx), но для server-to-server достаточно и HTTP.
- 5 минут на запуск.

## 1. Запуск relay

Скопируйте `scripts/wb-relay.mjs` на сервер (или клонируйте репозиторий) и запустите:

```bash
WB_RELAY_KEY='<случайный-ключ>' PORT=8787 node scripts/wb-relay.mjs
```

Ключ сгенерируйте локально:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Проверка с сервера:

```bash
curl "http://127.0.0.1:8787/wb/<ключ>?nm=1545780372"
```

Должен вернуться JSON от WB (`{"data":{"products":[...]}}`).

## 2. HTTPS (рекомендуется)

Если есть домен, поставьте Caddy:

```
wb.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Тогда URL relay: `https://wb.example.com/wb/<ключ>`.

Без домена можно использовать `http://<ip>:8787/wb/<ключ>` — GitHub Actions достучится,
но ключ будет передаваться по HTTP. Не используйте этот вариант для долгой эксплуатации.

## 3. systemd (чтобы relay жил после перезагрузки)

`/etc/systemd/system/wb-relay.service`:

```ini
[Unit]
Description=WB relay for price-radar
After=network.target

[Service]
WorkingDirectory=/opt/price-radar
Environment=PORT=8787
Environment=WB_RELAY_KEY=<ключ>
ExecStart=/usr/bin/node scripts/wb-relay.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wb-relay
```

## 4. Секрет в GitHub

Репозиторий → Settings → Secrets and variables → Actions → New repository secret:

- Name: `WB_PROXY_URL`
- Value: `https://wb.example.com/wb/<ключ>`

Workflow `check-prices` уже передаёт этот секрет в скрипт.

## 5. Проверка

Actions → `check-prices` → **Run workflow**. В логе должно быть:

```
1545780372: 1234 ₽
done, changes: true
```

После этого в `public/data/products.json` появится название и цена, а в
`public/data/history.json` — первая точка истории.

Проверить relay вручную:

```bash
curl "https://wb.example.com/wb/<ключ>?nm=1545780372"
```

## Безопасность

- Ключ должен быть случайным и не коммититься в репозиторий.
- Relay принимает только `nm` из 4–15 цифр и ходит только на `card.wb.ru`.
- Не выставляйте relay без ключа: иначе его смогут использовать как открытый прокси.
- Если есть возможность — ограничьте входящие IP или добавьте rate limit в Caddy.

## Если VPS нет

Варианты:

1. **Yandex Cloud Functions** — функция в РФ, бесплатный грант; код relay почти тот же.
2. **Домашний ПК** — запускать `node scripts/wb-relay.mjs` и открыть порт (нужен белый IP
   или туннель), либо запускать `check-prices.mjs` локально по расписанию.
3. **Существующий сервер** — если у вас уже есть RU-VPS под другие задачи, повесьте relay туда.
