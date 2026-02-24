const fs = require('fs');

const path = '/Volumes/SSD/ex/browser-agent-ext/src/tools/tools.js';
let content = fs.readFileSync(path, 'utf8');

// Use regex to insert `thought` inside `properties: {`
// And `required: ['thought', ...]` instead of `required: [...]` or add `required: ['thought']` if it doesn't exist.

// 1. Add thought to properties
content = content.replace(/properties:\s*\{/g, "properties: {\n        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },");

// 2. Add thought to required
// A tool definition looks like:
// {
//   name: '...',
//   parameters: { type: 'object', properties: { ... }, required: [...] }
// }

const toolBlocks = content.split(/(?=\n  \{|\n\];)/);

for (let i = 0; i < toolBlocks.length; i++) {
    if (!toolBlocks[i].includes('name:')) continue; // skip header or footer
    let block = toolBlocks[i];

    if (block.includes('required: [')) {
        block = block.replace(/required:\s*\[/, "required: ['thought', ");
    } else {
        // find the end of properties: { ... } and add required: ['thought']
        // this is tricky with string replacement.
        // Instead of regex, let's just insert it right after `parameters: { type: 'object',`
        block = block.replace(/parameters:\s*\{\s*type:\s*'object',/g, "parameters: {\n      type: 'object',\n      required: ['thought'],");
    }
    toolBlocks[i] = block;
}

content = toolBlocks.join('');

fs.writeFileSync(path, content, 'utf8');
console.log("Updated tools.js");
