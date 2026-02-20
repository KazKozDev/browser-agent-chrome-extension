const fs = require('fs');

let html = fs.readFileSync('sidepanel.html', 'utf8');

// I will adjust html to better match the exact image (dark brown, specific spacing, text colors)
const stylePatchStr = `
    :root {
      --bg-primary: #171513; 
      --bg-surface: rgba(220, 200, 150, 0.04);
      --bg-input: rgba(0,0,0, 0.25);
      --bg-hover: rgba(220, 200, 150, 0.08);
      --bg-active: rgba(220, 200, 150, 0.12);

      --border-subtle: rgba(220, 200, 150, 0.08);
      --border-default: rgba(220, 200, 150, 0.15);
      --border-emphasis: rgba(220, 200, 150, 0.25);
      --border-strong: rgba(220, 200, 150, 0.4);

      --text-primary: #efe0c8;
      --text-secondary: rgba(220, 200, 150, 0.45);
      --text-tertiary: rgba(220, 200, 150, 0.3);
      --text-muted: rgba(220, 200, 150, 0.15);

      --accent-gold: #cdb27d;
      --accent-gold-dim: rgba(205, 178, 125, 0.5);
      --accent-green: #6e9460;
      --accent-green-glow: rgba(110, 148, 96, 0.4);
      --accent-warning: #cc9955;
`;

html = html.replace(/:root\s*\{[\s\S]*?--accent-warning: #c4935a;/m, stylePatchStr);

fs.writeFileSync('sidepanel.html', html);
console.log('HTML colors tweaked');
