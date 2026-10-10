import { readFileSync, writeFileSync } from 'node:fs';
const R = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const wrap = name => {
  let s = R(`src/${name}.mjs`); const ex = [];
  s = s.replace(/^import\s*\{([^}]*)\}\s*from\s*'node:crypto';?$/gm, (_, n) => `const {${n}} = CRYPTO;`);
  s = s.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.mjs';?$/gm, (_, n, m) => `const {${n}} = M['${m}'];`);
  s = s.replace(/^export\s+(?:async\s+)?(?:const|function|class)\s+(\w+)/gm, (m0, n) => { ex.push(n); return m0.replace(/^export\s+/, ''); });
  s = s.replace(/^export\s*\{([^}]*)\};?$/gm, (_, n) => { ex.push(...n.split(',').map(x => x.trim())); return ''; });
  return `M['${name}'] = (() => {\n${s}\nreturn { ${ex.join(', ')} };\n})();\n`;
};
const shim = R('demo/shim.js').split('/*MODULES*/')[0];
const out = R('demo/landing.src.html').replace('/*ENGINE*/', shim + ['chain', 'policy', 'tools'].map(wrap).join('\n')).replace('/*POLICY*/', R('policies/default.json').trim());
writeFileSync(new URL('./landing.html', import.meta.url), out); console.log('built', out.length);
