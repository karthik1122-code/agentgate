// Kinetic type: headings are split into words and letters, then revealed by a staggered rise through a mask.
// The text stays readable to screen readers (aria-label on the heading, letters hidden) and nothing runs with reduced motion.
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLYPHS = '0123456789abcdef';

function split(root) {
  const walk = n => {
    if (n.nodeType === 3) {
      const frag = document.createDocumentFragment();
      n.textContent.split(/(\s+)/).forEach(part => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(' '); return; }
        const w = document.createElement('span'); w.className = 'kw';
        for (const ch of part) { const l = document.createElement('span'); l.className = 'kl'; l.textContent = ch; l.dataset.c = ch; w.append(l); }
        frag.append(w);
      });
      n.replaceWith(frag);
    } else if (n.nodeType === 1) [...n.childNodes].forEach(walk);
  };
  [...root.childNodes].forEach(walk);
  const letters = [...root.querySelectorAll('.kl')];
  letters.forEach((l, i) => l.style.setProperty('--i', i));
  return letters;
}

// Letters flicker through hex digits, then settle left to right: the hash motif, used on one headline.
function scramble(letters) {
  letters.forEach((l, i) => {
    const end = l.dataset.c; if (!/[a-z0-9]/i.test(end)) return;
    l.style.width = l.getBoundingClientRect().width + 'px';
    const t0 = performance.now() + i * 28, dur = 380;
    const tick = now => {
      if (now < t0) return requestAnimationFrame(tick);
      const k = (now - t0) / dur;
      if (k >= 1) { l.textContent = end; return; }
      l.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Letters near the pointer lift and lean, like a wave passing through the line.
function wave(root, letters) {
  let raf = 0, px = 0, py = 0;
  const frame = () => {
    raf = 0;
    for (const l of letters) {
      const r = l.getBoundingClientRect(); const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
      const k = Math.max(0, 1 - d / 140); l.style.setProperty('--w', k.toFixed(3));
    }
  };
  root.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(frame); });
  root.addEventListener('pointerleave', () => { letters.forEach(l => l.style.setProperty('--w', 0)); });
}

export function kinetic(sel = 'h1, h2', { hero = 'h1', mode = 'rise' } = {}) {
  if (still) return;
  document.documentElement.classList.add('kin');
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target); e.target.classList.add('kin-in');
    if (e.target.dataset.kin === 'scramble') scramble(e.target._letters);
    setTimeout(() => e.target.classList.add('kin-done'), e.target._letters.length * 22 + 800);
  }), { threshold: 0.35 });
  document.querySelectorAll(sel).forEach(h => {
    const label = h.textContent.trim().replace(/\s+/g, ' ');
    const letters = split(h); h._letters = letters;
    h.setAttribute('aria-label', label); letters.forEach(l => l.setAttribute('aria-hidden', 'true'));
    h.classList.add('kin-h');
    if (h.matches(hero)) { h.dataset.kin = mode; if (mode === 'rise') wave(h, letters); }
    io.observe(h);
  });
}
