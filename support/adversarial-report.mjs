import { runCases } from './adversarial-run.mjs';
const rows = await runCases();
const attacks = rows.filter(r => r.attack), benign = rows.filter(r => !r.attack);
const cats = [...new Set(attacks.map(r => r.category))];
console.log('| Category | Cases | Denied | Held for a human | Executed |\n|---|---|---|---|---|');
for (const c of cats) { const s = attacks.filter(r => r.category === c); console.log(`| ${c} | ${s.length} | ${s.filter(r => r.outcome === 'deny').length} | ${s.filter(r => r.outcome === 'approve').length} | ${s.filter(r => r.outcome === 'allow').length} |`); }
console.log(`| **All attacks** | **${attacks.length}** | **${attacks.filter(r => r.outcome === 'deny').length}** | **${attacks.filter(r => r.outcome === 'approve').length}** | **${attacks.filter(r => r.outcome === 'allow').length}** |`);
console.log(`\nLegitimate calls: ${benign.length}. Allowed: ${benign.filter(r => r.outcome === 'allow').length}. Held for a human (by design): ${benign.filter(r => r.outcome === 'approve').length}. Wrongly denied: ${benign.filter(r => r.outcome === 'deny').length}.`);
console.log(`Cases matching their required outcome: ${rows.filter(r => r.ok).length}/${rows.length}. Side effects from attacks: ${attacks.filter(r => r.sideEffect).length}.`);
