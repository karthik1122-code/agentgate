// Builds one self-contained HTML file that runs the real dashboard against the real policy engine and runtime in the browser.
import { readFileSync, writeFileSync } from 'node:fs';
const R = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mods = ['chain', 'policy', 'tools', 'store', 'runtime', 'scenarios'];
const wrap = name => {
  let s = R(`src/${name}.mjs`); const ex = [];
  s = s.replace(/^import\s*\{([^}]*)\}\s*from\s*'node:crypto';?$/gm, (_, n) => `const {${n}} = CRYPTO;`);
  s = s.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.mjs';?$/gm, (_, n, m) => `const {${n}} = M['${m}'];`);
  s = s.replace(/^export\s+(?:async\s+)?(?:const|function|class)\s+(\w+)/gm, (m0, n) => { ex.push(n); return m0.replace(/^export\s+/, ''); });
  s = s.replace(/^export\s*\{([^}]*)\};?$/gm, (_, n) => { ex.push(...n.split(',').map(x => x.trim())); return ''; });
  if (/^(import|export)\b/m.test(s)) throw new Error(`unhandled import/export in ${name}`);
  return `M['${name}'] = (() => {\n${s}\nreturn { ${ex.join(', ')} };\n})();\n`;
};
const shim = R('demo/shim.js');
const css = R('public/style.css');
const html = R('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="app.js"')).trim();
const app = R('public/app.js').replace(/'Demo mode: there are no accounts[^']*'/, "'Live browser demo: the real policy engine and approval runtime run in this page, with nothing sent anywhere. Your real deployment adds accounts and a database.'");
const policy = R('policies/default.json');
const out = `<title>AgentGate</title>
<meta name="description" content="Approvals for AI agent actions: policy, human approval and a tamper-evident log. Runs entirely in your browser.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${css}</style>
${body}
<script>
(() => {
const M = {};
${shim.split('/*MODULES*/')[0]}
${mods.map(wrap).join('\n')}
const POLICY = ${policy.trim()};
${shim.split('/*MODULES*/')[1]}
})();
</script>
<script>
${R('public/theme.js')}
(async () => {
${app}
})();
</script>
`;
writeFileSync(new URL('./dist.html', import.meta.url), out);
console.log('built', out.length);
