# FOLLOWUPS — баги вне текущего WP

> Правило ветки: увидел баг за пределами текущего пакета работ — запиши сюда
> `file:line` и иди дальше. Не чинить «попутно» внутри чужого шага.
> Формат: дата · шаг · файл:строка · симптом · почему вне scope · что предлагается.

## Открытые

### F0 · `src/client/artwork.ts` · `memberSymbolUrl('Lead', 'Team Lead')` → `null`
**Найдено:** при проверке после языковой правки (не мой коммит).
**Коммит-источник:** `370548f feat(client): amber terminal mascots, dedicated symbol packs for the corner badge`.
**Симптом:** `scripts/verify.mjs` падает на
`canonical eight-member roster resolves to eight distinct corner symbols`
(1 FAIL, 211 PASS). Восемь ролей резолвятся корректно, ломается последнее условие:

```
LEAD_SYMBOL                              = "/plugins/dsh-agent-teams/assets/team-lead-symbol.png"
memberSymbolUrl('Lead', 'Team Lead')     = null
memberSymbolUrl('Lead','Team Lead') === LEAD_SYMBOL  -> false
```

**Почему вне scope:** это работа соседнего агента по иконкам (`src/client/` +
`assets/agent-teams/`); правило ветки — не чинить чужой шаг, а записать.
**Что предлагается:** научить `memberSymbolUrl` возвращать `LEAD_SYMBOL` для
lead-роли (`/lead|team lead|captain/i`) либо убрать это условие из ассерта, если
lead-символ намеренно резолвится отдельной функцией. Проверка воспроизведения:

```sh
cmd /c ".local\pnpm.cmd exec node scripts/verify.mjs"
node -e "import('./lib/client/artwork.js').then(m => console.log(m.memberSymbolUrl('Lead','Team Lead'), m.LEAD_SYMBOL))"
```

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

## Закрытые

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
