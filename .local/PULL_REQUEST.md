# PR draft — AgentTeams: waivable acceptance, transitive scope serialization, three read-only panel views

> Ветка: `WhiteWh:toolkit-fix` (9 коммитов поверх `87c95c9`).
> **Ничего не отправлено в upstream.** Это заготовка описания на случай, если
> решите открыть PR: GitHub → `WhiteWh/dsh-agent-teams` → Compare & pull request.
> Жёсткое требование владельца: без PR, пока не попросят.

## Что это

Набор из четырёх релизных шагов, собранных строго по TDD из локального плана
(`Docs/AGENT_TEAMS_IMPROVEMENT_PLAN.md`) и двух инцидент-репортов
(`Docs/AGENT_TEAMS_FEEDBACK.md`, `.local/feedback-multi-team.md`).

### 1. Приёмка: `waived` и `no_regression` (фидбэк §2)

Инцидент: две acceptance-проверки `t5` были красны на HEAD по внешней причине.
Честный исполнитель отказался писать `passed`, гейт требовал «все passed» — задача
получила `failed`, терминальный статус, и вся ветка потомков зависла. Восстановление
стоило 5 отмен + 7 созданий задач.

- `AcceptanceResult.status` / `CommandResult.status` получили `waived` с
  обязательным непустым `evidence` (проверяется и в парсере тула, и на границе
  `team.json`).
- Критерий может быть объектом `{text, mode:'no_regression', baseline}`: «не хуже
  названной базы» вместо «зелено».
- **Удалён fallback по длине массива**, который принимал любой same-length all-pass
  отчёт (то есть отчёт про другие критерии тоже проходил). Заменён нормализацией
  текста (trim, схлопывание пробелов, снятие хвостовой пунктуации) + перечисление
  непокрытых критериев в тексте ошибки.
- Задача с waiver помечается `hasWaivers`, и Delivery блокируется строкой
  `<id> has unconfirmed waivers` до явного `waiverConfirmation` от `kind=review` с
  `verdict=pass`. `reviewPolicy.allowWaivers: false` выключает механизм.

### 2. Scope-overlap по транзитивному замыканию (фидбэк §5)

Скип проверки пересечения `inScope` смотрел только прямые зависимости, поэтому
создание задачи-замены упиралось в «inScope overlaps …; serialize these tasks».
Теперь учитывается замыкание зависимостей, при этом **общий предок сериализацией
не считается** (иначе реальный конфликт прошёл бы). Мёртвое условие
`other.dependencies.includes('pending-new')` удалено.

### 3. Delivery и линт профилей (фидбэк §6.1, §6.2)

- Путь-аудит Delivery идёт только по `completed`-задачам: `changedPaths`
  отменённой задачи больше не засоряет отчёт.
- Ошибка на неизвестный ключ профиля называет вложенность:
  `requiredReviewers belongs under reviewPolicy
  (profiles.material.reviewPolicy.requiredReviewers)`.
- `node scripts/doctor.mjs --profiles <config.json>` линтит структуру ключей
  профилей, включая вложенные (`members[]`, `tasks[]`, `fallback`).

### 4. Панель: три read-only разреза (требование пользователя)

Рядом с деревом зависимостей — **Phases** (колонки по объявленным фазам, иначе по
уровням DAG, с рёбрами между колонками), **Agents** (swimlane на участника, чипы
по порядку исполнения, заблокированные приглушены с указанием виновника) и
**Queues** (кто что держит, что следующее, сгруппированная причина простоя).
Выбор представления запоминается в `localStorage`. Всё считается чистыми селекторами
в `activity-model.ts` и покрыто тестами без React.

### 5. Технический долг и фикс планировщика

- Единая таблица переходов статусов: `quality-gates.ts` читает `TASK_TRANSITIONS`
  из `state.ts` вместо второй копии.
- **Фикс планировщика** (`0108c81`), найденный при воспроизведении `t5`: свежий
  attempt участника (между `claim_task` и первым `update_task`) принимался за
  потерянного владельца и переклеймился — `in_progress` откатывался на `claimed`,
  счётчик attempt рос, следующий `update_task` участника отвергался как stale.
  Плюс recovery перекрывал раздачу свежей работы. Оба случая исправлены и закрыты
  регрессиями в `scripts/lifecycle-verify.mjs`.

## Совместимость

- `team.json` старых версий читается: `waived`, критерии-объекты, `hasWaivers`,
  `waiverConfirmation` опциональны на чтении; строка как критерий сохраняет смысл.
- Матрица хостов не менялась (`compatibility.json` без изменений):
  `0.1.5-rc.1`, `0.1.2-rc.1`, `0.1.2-alpha.5`, `0.1.2-alpha.2`.
- **Сигнатуры тулов не менялись.** Обязательный `team_id` для team-scoped тулов —
  следующий релиз, не в этом PR.

## Проверки

| Что | Результат |
| --- | --- |
| `pnpm typecheck`, `pnpm build` | pass |
| `scripts/verify.mjs` | 210 PASS / 0 FAIL (база 181/0) |
| `scripts/quality-gates-tdd.mjs` | 106 PASS / 0 FAIL |
| остальные 17 сьютов (`lifecycle`, `stress`, `web-routes`, `capability`, …) | exit 0 |
| `readme-version`, `release-metadata`, `sync-skill --check` | pass |
| t5-replay на реальных тулах | 7/7 |
| real-host матрица (`harness-runtime-verify.mjs`) | не прогонялась на этой машине |

## Ссылки на upstream-issue

Частично закрывает: #174 (замороженный сгенерированный контракт), #175 (repair не
привязан к findings), #183 (derived `inScope` против default-excluded), #161
(deliverable не привязан к ревизии). Полностью закрывает инцидент с ложным
`failed` из-за внешне красных критериев.
