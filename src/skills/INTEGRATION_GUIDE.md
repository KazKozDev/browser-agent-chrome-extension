# Интеграция скиллов в браузерный агент

## Архитектура

```
your-extension/
├── skills/
│   ├── SKILLS_INDEX.md        ← Индекс (грузится в системный промпт)
│   ├── product-search.md
│   ├── form-fill.md
│   ├── data-extract.md
│   ├── login-auth.md
│   ├── navigation.md
│   ├── booking.md
│   └── monitoring.md
├── agent.js                   ← Добавить загрузку скиллов
├── tools.js
└── content.js
```

## Шаг 1: Загрузка индекса в системный промпт

В `agent.js`, в формировании system prompt, добавьте индекс скиллов:

```javascript
// В начале файла или при инициализации агента
const SKILLS_INDEX = `...содержимое SKILLS_INDEX.md...`;

// Массив скиллов (можно хранить как объект или загружать из файлов)
const SKILLS = {
  'product-search': `...содержимое product-search.md...`,
  'form-fill': `...содержимое form-fill.md...`,
  'data-extract': `...содержимое data-extract.md...`,
  'login-auth': `...содержимое login-auth.md...`,
  'navigation': `...содержимое navigation.md...`,
  'booking': `...содержимое booking.md...`,
  'monitoring': `...содержимое monitoring.md...`,
};
```

## Шаг 2: Выбор скилла (два варианта)

### Вариант A: Автоматический (рекомендуется)

Добавить в system prompt инструкцию + индекс.
Модель сама выбирает скилл по задаче:

```javascript
const systemPrompt = `
${EXISTING_SYSTEM_PROMPT}

## Навыки (Skills)
${SKILLS_INDEX}

ПРАВИЛО: Перед началом задачи определи подходящий скилл.
Если скилл найден — следуй его шагам и ловушкам.
Если не найден — действуй по общей логике.
Запроси скилл, указав его ID в первом сообщении:
<skill>product-search</skill>
`;
```

В коде `agent.js` в цикле `run()` после первого ответа модели,
парсите тег `<skill>` и подгружаете содержимое скилла
в следующее сообщение как контекст:

```javascript
// После получения первого ответа от LLM
const skillMatch = response.match(/<skill>([\w-]+)<\/skill>/);
if (skillMatch && SKILLS[skillMatch[1]]) {
  const skillContent = SKILLS[skillMatch[1]];
  // Добавляем скилл как системное сообщение в историю
  this.messages.push({
    role: 'system',
    content: `Активирован скилл: ${skillMatch[1]}\n\n${skillContent}`
  });
}
```

### Вариант B: Классификатор на первом шаге

Перед основным циклом — один быстрый вызов к LLM:

```javascript
async function classifyTask(userMessage) {
  const classifyPrompt = `
Задача пользователя: "${userMessage}"
Доступные скиллы: product-search, form-fill, data-extract,
login-auth, navigation, booking, monitoring, none.
Ответь ОДНИМ словом — ID скилла или "none".`;

  const skillId = await this.llm.complete(classifyPrompt);
  return SKILLS[skillId.trim()] || null;
}
```

Этот вариант тратит немного токенов, но точнее для слабых моделей.

## Шаг 3: Экономия контекста для локальных моделей

Скиллы занимают ~200-400 токенов каждый. Для Qwen-VL:8b или Llama это ощутимо.
Решение — грузить ТОЛЬКО выбранный скилл, а не весь индекс:

```javascript
// Для мощных моделей (Claude, GPT): индекс + выбранный скилл
// Для локальных моделей: ТОЛЬКО выбранный скилл (без индекса)
const isLocalModel = this.config.provider === 'ollama';

if (isLocalModel) {
  // Классификатор на первом шаге, затем только 1 скилл в контексте
  const skill = await classifyTask(userMessage);
  if (skill) systemPromptAddition = skill;
} else {
  // Индекс в system prompt, модель сама выбирает
  systemPromptAddition = SKILLS_INDEX;
}
```

## Шаг 4: Добавление пользовательских скиллов (на будущее)

Позволить пользователям создавать свои скиллы через UI расширения:

```javascript
// Формат пользовательского скилла
const customSkill = {
  id: 'my-crm-update',
  name: 'Обновление CRM',
  trigger: 'обнови crm, добавь контакт, внеси в базу',
  steps: [
    'Открой CRM по адресу https://mycrm.com',
    'Перейди в раздел "Контакты"',
    'Нажми "Добавить контакт"',
    'Заполни поля из данных пользователя',
  ],
  warnings: ['Не удаляй существующие контакты'],
};

// Сохраняется в chrome.storage.local
await chrome.storage.local.set({
  customSkills: [...existingSkills, customSkill]
});
```

## Приоритет внедрения

1. **Сейчас**: Встроить 7 скиллов как константы в agent.js + авто-выбор
2. **Через неделю**: A/B тест — задачи со скиллами vs без, замерить success rate
3. **Через месяц**: UI для пользовательских скиллов
