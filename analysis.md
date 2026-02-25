# Анализ архитектуры: код vs исследование

## Приоритетный roadmap (по impact)

1. [x] Network-level domain filtering (DNR dynamic rules, блок всех request types)
2. [x] Multi-action batching (reflection: `actions[]` вместо `next_action`)
3. [x] Structured sub-goals (`SubGoal[]`: status/confidence/evidence/attempts)
4. [x] LLM-based history summarization (Tier 2, incremental anchored summary)
5. [x] Rollback/state snapshots перед irreversible actions

## Что сделано в этом коммите

- Добавлена сетeвая блокировка доменов на уровне `chrome.declarativeNetRequest` в background service worker.
- DNR-правила переведены на domain-aware matching (`requestDomains`) с fallback на `urlFilter` для совместимости.
- Синхронизация DNR-правил при старте расширения, обновлении blocklist и изменении `chrome.storage.local`.
- Добавлен security preflight: task/recovery/scheduled run не стартуют, если network block rules не удалось синхронизировать.
- Добавлена дополнительная синхронизация на `chrome.runtime.onInstalled` и `chrome.runtime.onStartup`.
- Нормализация доменов blocklist (убираются схемы/`www`/path/`user@host` шум).
- Усилена валидация URL навигации: запрещены `user:pass@host` URL.
- Добавлены unit-тесты для URL/blocklist security кейсов.
- Реализован multi-action batching: reflection теперь поддерживает `actions[]` (до 4 действий/шаг), run-loop исполняет batch в одном step с сохранением early-break на navigation.
- Реализован structured sub-goal tracking: `SubGoal[]` с полями `status/confidence/evidence/attempts`, авто-инициализация из goal, обновление по каждому action, интеграция в task-state message и checkpoint/resume.
- Реализован Tier-2 context compression: evicted history turns собираются в pending chunks, инкрементально сжимаются через LLM в running summary и подмешиваются в `[TASK STATE TRACKER]`; summary сохраняется в checkpoint/resume.
- Реализован Tier-3 retrieval memory (embedding-like RAG): evicted chunks индексируются в `ragEntries`, затем top-k релевантных архивных фрагментов подмешиваются в `[TASK STATE TRACKER]` как `Relevant archived memory (semantic retrieval)`.
- Реализован rollback/state snapshot manager: авто-capture snapshot перед risk actions (`click(confirm)`, submit via Enter, risky `javascript`), tool `restore_snapshot` для отката URL/cookies/scroll, и сохранение snapshot state в checkpoint/resume.

## Следующий слой (после топ-5)

- Реализован composite confidence в reflection: `effective = 0.6 * corrected_llm_confidence * stagnation_penalty * loop_penalty + 0.4 * progress_ratio`.
- Добавлена overconfidence-коррекция (`* 0.85`) и stagnation decay (`0.9 ** noProgressStreak`) в калибровку confidence.
- Добавлены resource budgets в run-loop: wall-clock, total tokens, estimated USD cost с early-stop.
- Добавлен structured terminal output: `status` + `partial_result` (`complete|partial|failed|timeout|stuck`, `remaining_subgoals`, `suggestion`).
- Adaptive perception: добавлен sparse-AX детектор (low interactive density) с авто-fallback на vision для interaction-oriented шагов.
- Adaptive perception: `_waitForNavigation()` теперь дожидается DOM settle через `MutationObserver` (`waitForDomSettle`) вместо фиксированного `500ms` хардкода.
- Adaptive perception: `read_page` стал task-aware (более компактный viewport-oriented профиль для form-like целей, более широкий профиль для extraction-like задач).
- Adaptive perception: в vision prompt добавлен structured SoM payload (`id/label/x/y/w/h` JSON), не только legend-строка.
- Добавлен pre-send token estimation: перед `provider.chat` выполняется прогноз input/output токенов и preflight budget-check; reflection-call блокируется заранее при overflow, history summarization переходит в skip-mode без LLM вызова.
- Добавлен human-in-the-loop escalation для medium confidence: при `confidence ~0.5-0.85` под стагнацией/дефицитом step-budget агент ставит `paused_waiting_user` с `guidance_needed`, ждёт Resume и продолжает с user-reviewed контекстом.
