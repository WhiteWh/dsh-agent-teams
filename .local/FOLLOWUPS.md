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

## Закрытые

_(пусто)_
