# Wiki Telegram Bot

Бот ищет в Википедии и Fandom Wiki и собирает краткий ответ без нейросетей
(выбирает самые релевантные запросу предложения). Работает на Cloudflare Workers (бесплатно).

## Команды
- текст — поиск в Википедии
- `/wiki запрос`
- `/fandom вики запрос` (например `/fandom minecraft creeper`, `/fandom genshin-impact/ru Венти`)
- `/setwiki название` — Fandom по умолчанию
- `/admin` — админ-панель (только админы)

## Админ-панель
Ссылки для доп. информации, блокировка по @username / ID, добавление и удаление админов.
Владелец: `@hamtik26kk` (задаётся в `wrangler.toml`, `OWNER_USERNAME`).

## Установка
1. Создайте бота у @BotFather, скопируйте токен.
2. Cloudflare → Workers & Pages → KV → Create namespace (например `wiki-bot`). Скопируйте ID в `wrangler.toml`.
3. Cloudflare → My Profile → API Tokens → шаблон **Edit Cloudflare Workers** → создайте токен. Account ID — на главной странице Workers.
4. Загрузите файлы в репозиторий GitHub. В Settings → Secrets and variables → Actions добавьте:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `BOT_TOKEN` — токен бота
   - `WEBHOOK_SECRET` — любая строка из латинских букв, цифр, `_` и `-`
5. Push в `main` — GitHub Actions задеплоит воркер.
6. Откройте один раз в браузере:
   `https://wiki-telegram-bot.<ваш-поддомен>.workers.dev/setup?key=<WEBHOOK_SECRET>`
   Должно вернуться `"ok":true`.
7. Напишите боту `/admin` с аккаунта @hamtik26kk.

Админа по @username бот узнаёт, когда тот что-то напишет боту; по числовому ID — сразу.
