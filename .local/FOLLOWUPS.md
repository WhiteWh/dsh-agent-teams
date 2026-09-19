# FOLLOWUPS — баги вне текущего WP

> Правило ветки: увидел баг за пределами текущего пакета работ — запиши сюда
> `file:line` и иди дальше. Не чинить «попутно» внутри чужого шага.
> Формат: дата · шаг · файл:строка · симптом · почему вне scope · что предлагается.

## Открытые

### F1 · `src/scheduler.ts` · `installTeamScheduler` · порядок выбора задачи
**Найдено:** S07, при написании t5-replay (`0108c81` уже исправил половину).
**Симптом:** `recoverOwned` перекрывал `nextReadyTask`, поэтому участник с
открытой (но фактически брошенной) задачей никогда не получал следующий
pending-таск — он вечно «восстанавливал» старую. Исправлено на
`const ready = nextReadyTask(...); const task = ready ?? (recoverOwned ? owned : undefined)`.
**Остаток вне scope:** `ownedOpenTask` возвращает **первую** открытую задачу
(`tasks.find`), а не самую старую/приоритетную. При нескольких открытых задачах
у одного участника (возможно после ручных правок `team.json` или `replan` из
S17) выбор недетерминирован по порядку массива. Предлагается сортировать по
`createdAt` или явно документировать «первая по порядку в team.json».

### F2 · `src/quality-gates.ts` · `canDeclareDelivery` · `implementations` без статуса
**Найдено:** S04.
**Симптом:** блок «completed implementation has no passing review» считается по
`implementations.some(status === 'completed')`, но сам список включает и
`failed`/`cancelled`/`pending`. Сейчас это не стреляет, потому что рядом стоит
проверка `some(completed)`. Если в S09 (`superseded`) или S12
(`requiredReviewers`) условие переписать, легко получить ложный блокер.
**Предлагается:** при правке этого блока в S12 выделить
`const completedImplementations = implementations.filter(status === 'completed')`
и считать от него.

### F3 · `scripts/doctor.mjs` · `--profiles` принимает только JSON
**Найдено:** S05.
**Симптом:** реальный профиль — это `cordis.patch.yml` (YAML). Линт требует
JSON-экспорт конфига, потому что у плагина нет YAML-парсера, а добавление
зависимости тронуло бы `pnpm-lock.yaml`.
**Предлагается:** в upstream добавить `js-yaml` (или использовать парсер хоста
через `--dump-config`) и принимать YAML напрямую. До этого — в доке явно
сказано «export the provider config as JSON».

### F4 · `src/index.ts:474-477` · арт-маршрут кэшируется на сутки по неизменяемому URL
**Найдено:** 2026-09-20, при проверке деплоя 0.1.21 (владелец: «не вижу наших иконок»).
**Симптом:** панель в браузере показывает **старый** китовый пак (`member-engineer-v2.png`
78 170 Б, `team-lead-v2.png` — кит в белой фуражке), тогда как в установленном пакете
лежат янтарные терминалы (`member-engineer-v2.png` 39 838 Б; все 30 файлов совпадают
с локальными по SHA256, маршрут читает `join(artDir, name)` из загруженного модуля).
**Причина:** имена файлов не менялись между паками (`member-*-v2.png` появились ещё в
`47183d8`, китовый пак), а маршрут отдаёт `cache-control: public, max-age=86400`
(`src/index.ts:476`) — браузер держит старые байты по тому же URL до 24 часов. Новые
`-symbol.png` — новые URL, поэтому бейджи в углу обновляются, а портреты нет.
**Вне scope:** это не шаг плана (S08–S20), а дефект отдачи ассетов; чинить внутри
чужого шага запрещено правилом ветки.
**Предлагается:** ревизия в URL — `ART_BASE` + `?v=<константа пака>`, поднимать её при
смене арта (сервер уже игнорирует query: `pathname.split('/').pop()`), либо
`no-cache` + `ETag` вместо `max-age`. Hard reload лечит только текущий браузер.

### F5 · `src/client/activity-model.ts` · `agentSwimlanes` больше не рендерится
**Найдено:** 2026-09-20, при удалении вида Agents по просьбе владельца.
**Симптом:** проекция `agentSwimlanes` (+ тип `Swimlane`) осталась в модели и
покрыта пятью проверками, но ни один компонент её не использует — панель теперь
рисует только дерево, Phases и Queues. В бандл она не попадает (tree-shaking),
так что это вопрос гигиены исходников, а не размера пакета.
**Почему не удалено сразу:** удаление означало бы снять пять зелёных проверок в
одном коммите с UI-правкой; владелец просил убрать раздел, а не проекцию.
**Предлагается:** либо вернуть вид (проекция уже написана и протестирована), либо
удалить `agentSwimlanes`/`Swimlane` и их проверки
(`agent swimlanes keep one row per member plus an unassigned row`,
`swimlane buckets split completed, running, queued and blocked work`,
`swimlane marks finished work as completed`, `queue reports the blocking
dependency by id` — часть проверок опирается на те же хелперы).

### F6 · `scripts/stress-verify.mjs` · сценарий «две команды, один свободный участник» отложен
**Найдено:** S14 (WP11 фаза 1), из списка тестов плана для WP11.
**Симптом/причина:** план требует стресс-проверку «две команды, один свободный
участник, нет двойного назначения». В фазе 1 участник принадлежит ровно одной
команде, назначение идёт внутри одной команды, поэтому двойное назначение
невозможно by construction — сценарий проверял бы фазу 2 (общий планировщик и
глобальный лимит воркеров, S18). Фаза 1 покрыта блоком multi-team в
`scripts/lifecycle-verify.mjs` (две команды, `new_team`, отсутствующий `team_id`,
список `status`, изоляция `update_task`, архив одной команды, лимит 4 живых команд).
**Предлагается:** написать сценарий в S18 вместе с кросс-командным планировщиком
и общим лимитом воркеров.

## Закрытые

### F4 · арт-маршрут кэшировался на сутки по неизменяемому URL · закрыто в 0.1.22
**Найдено:** 2026-09-20, при проверке деплоя 0.1.21 (владелец: «не вижу наших иконок»).
**Симптом:** панель в браузере показывала **старый** китовый пак (`member-engineer-v2.png`
78 170 Б, `team-lead-v2.png` — кит в белой фуражке), тогда как в установленном пакете
лежали янтарные терминалы (39 838 Б; все 30 файлов совпадали с локальными по SHA256,
маршрут читает `join(artDir, name)` из загруженного модуля).
**Причина:** имена файлов не менялись между паками (`member-*-v2.png` появились ещё в
`47183d8`, китовый пак), а маршрут отдавал `cache-control: public, max-age=86400` —
браузер держал старые байты по тому же URL до 24 часов. Новые `-symbol.png` — новые URL,
поэтому бейджи в углу обновлялись, а портреты нет.
**Исправлено (0.1.22):** у каждого URL арта теперь есть ревизия пака
(`?v=<hash>`), её считает `scripts/art-revision.mjs` из байтов `assets/agent-teams/`
и кладёт в `src/client/art-revision.ts`; `pnpm build` и `scripts/verify.mjs` падают на
устаревшей константе. Маршрут вынесен в `src/artwork.ts` (`serveArtwork`), читает только
путь и по-прежнему отдаёт лишь имена из allowlist. Регрессии: `the committed artwork
revision describes the packaged images`, `a redrawn artwork file changes the revision`,
`every artwork URL carries the pack revision`, `the artwork route ignores the
cache-busting query`, `the artwork route serves allowlisted names only`. Мутационная
проверка: реализация, читающая имя из сырого `req.url`, валит сьют (1 FAIL).
**Результат:** `verify.mjs` 219 PASS / 0 FAIL.

### F0 · `memberSymbolUrl` не знал lead-роль · закрыто
**Симптом:** `scripts/verify.mjs` падал на
`canonical eight-member roster resolves to eight distinct corner symbols`:
`memberSymbolUrl('Lead', 'Team Lead')` возвращал `null` вместо `LEAD_SYMBOL`
(1 FAIL / 211 PASS).
**Причина:** функция не имела lead-ветки, хотя `LEAD_SYMBOL` экспортируется и
используется панелью напрямую. Вторая, менее очевидная причина: первая версия
проверки сравнивала роль как есть, а роль приходит с заглавной буквы
(`Team Lead`), тогда как таблица `ROLE_ART` работает по `toLowerCase()`.
**Исправлено:** lead-ветка `/lead|captain|队长|组长/u` проверяется по
`role.toLowerCase()` **до** таблицы ролей и только по роли, а не по
`name + role`, чтобы участник с именем `Lead` и обычной ролью не забирал
lead-символ. Регрессии: `a lead-role member resolves to the lead symbol`,
`an ordinary role is not mistaken for the lead by name alone`.
**Результат:** `verify.mjs` 214 PASS / 0 FAIL.

### Принятые чужие PR-ы · 2026-09-20 · коммит `4490366` · откат `backup/pre-pr-adoption-2d451b5`

Разобраны все 20 открытых PR-ов апстрима (отчёт: `.dsh-scratch/upstream-prs-report.md`, диффы — `.dsh-scratch/pr-diffs/`).
Взято:

- **#186** — Harness `0.1.5-rc.2` треком `preview` в `compatibility.json` (рекомендованный хост не менялся),
  `0.1.5-rc.2` в 21 peer-диапазоне, `docs/harness-0.1.5-rc.2-acceptance.md`. Ноль исполняемого кода.
- **#169** — убран самодельный `source.kind = 'agent-teams-command'` (`src/command.ts`): у хоста закрытый
  `SOURCE_KINDS` в `@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js:14` (есть `plugin`, нашего kind нет),
  L125 бросает `SessionFormatUnsupportedMigrationError` — сессии с `/agent-teams` не открывались после
  апгрейда хоста (issue #160). Обе директивы пишут `{ kind: 'plugin', plugin: 'dsh-agent-teams' }`.
  Тест `scripts/command-source.test.mjs` (3/3), скрипт `verify:command-source`.
- **#177** — `evaluateQualityCompletion` называет оба сталкивающихся списка, когда путь есть и в `inScope`,
  и в `outOfScope` (раньше голое `is out_of_scope` винило путь). Тест — секция I в нашем qg-tdd.
- **#140** — `scripts/verify-events.mjs` + `scripts/mock-dsh-session-loader.mjs` (7/7): write-guard событий
  из `src/events.ts`. Скрипт `verify:events`, в агрегатный `verify` намеренно не добавлен (как в PR).
- **#141** — `export const name` в `src/index.ts` совпадает с именем пакета. Одна строка.

### Что осталось невзятым и почему · 2026-09-20

- **#171** — durable-причина отклонённого dispatch (`lastDispatchError`). Исходники не трогали: пять guard-ов в
  `src/tools.ts:461-464` возвращают `false` молча, причина видна только для брошенного spawn (`member.spawnError`).
  Логичнее накладывать после S08/S09 — дифф ложится на `state.ts`/`types.ts`/`tools.ts`.
- **#182** — баг реальный (санитизации `<parameter=` нет нигде), но патч ломает `import` в двух клиентских файлах
  и тащит vitest, которого в проекте нет. Нужен свой `src/sanitize.ts` и обрезка на входе 4 хендлеров.
- **#80** — UI истории команд. Серверная половина уже наполовину есть (`archiveTeamDir` `src/state.ts:945`,
  `?archived=1` `src/index.ts:226`); не хватает purge/hide/restore и панели. Purge — `rm -rf` по пути из запроса.
- **#48** — серверная половина уже реализована (`dependencyOutputs` `src/scheduler.ts:90/115/156/253`), брать только
  2-3 формулировки в member-промпт. Forward references не брать: у нас на замкнутости DAG стоит S02/WP5.
- Отложены/отклонены: **#144** (референс для S19), **#147** (нет 3 зависимостей), **#37/#31** (мелкие тумблеры),
  **#32**, **#21**, **#38**, **#67**, **#118**, **#149**, **#179** (уже не нужен — фикстура стоит на 14).

### Окружение · `pnpm verify` здесь падает раньше EPERM · 2026-09-20

`scripts/verify.mjs` падает в песочнице на cross-process file-lock (spawn EPERM, named pipes). Проверено:
тот же провал воспроизводится на **неизменённом** родительском коммите в отдельном worktree — это ограничение
машины, а не регрессия. Обход, которым проверялся перенос: серверные `*.mjs` — напрямую `node <file>`,
`node --test`-файлы — тоже прямым запуском (`node scripts/command-source.test.mjs` даёт 3/3).
