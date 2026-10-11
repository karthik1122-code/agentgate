// Kinetic type. Modelled on the controls a motion tool exposes: split by letter or word, stagger with a delay,
// then move / rotate / scale / blur / colour / clip-mask each unit. Headings play when they scroll into view;
// paragraphs fill in word by word as you scroll; large buttons lean toward the pointer.
// Text stays readable to screen readers, and nothing runs with reduced motion.
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(pointer: fine)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function eachText(root, fn) {
  const walk = n => { if (n.nodeType === 3) fn(n); else if (n.nodeType === 1 && !/^(SCRIPT|STYLE|CODE|PRE)$/.test(n.tagName)) [...n.childNodes].forEach(walk); };
  [...root.childNodes].forEach(walk);
}

function splitHeading(root) {
  let wi = 0;
  eachText(root, n => {
    const frag = document.createDocumentFragment();
    n.textContent.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { frag.append(' '); return; }
      const w = document.createElement('span'); w.className = 'kw'; w.style.setProperty('--wi', wi++);
      for (const ch of part) { const l = document.createElement('span'); l.className = 'kl'; l.textContent = ch; w.append(l); }
      frag.append(w);
    });
    n.replaceWith(frag);
  });
  const letters = [...root.querySelectorAll('.kl')];
  letters.forEach((l, i) => { l.style.setProperty('--i', i); l.setAttribute('aria-hidden', 'true'); });
  return letters;
}

function splitFill(root) {
  const words = [];
  eachText(root, n => {
    const frag = document.createDocumentFragment();
    n.textContent.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { frag.append(' '); return; }
      const w = document.createElement('span'); w.className = 'fw'; w.textContent = part; words.push(w); frag.append(w);
    });
    n.replaceWith(frag);
  });
  return words;
}

// Letters near the pointer lift and lean, like a wave passing through the line.
function wave(root, letters) {
  let raf = 0, px = 0, py = 0;
  const frame = () => { raf = 0; for (const l of letters) { const r = l.getBoundingClientRect(); const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2)); l.style.setProperty('--w', Math.max(0, 1 - d / 140).toFixed(3)); } };
  root.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(frame); });
  root.addEventListener('pointerleave', () => letters.forEach(l => l.style.setProperty('--w', 0)));
}

function magnet(el) {
  el.dataset.mag = '';
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height;
    el.style.translate = `${(x * 10).toFixed(1)}px ${(y * 8).toFixed(1)}px`;
  });
  el.addEventListener('pointerleave', () => { el.style.translate = ''; });
}

export function kinetic({ fx = { h1: 'rise', h2: 'rise' }, color = '', waveOn = 'h1', fill = '[data-fill]', magnetic = '' } = {}) {
  if (still) return;
  document.documentElement.classList.add('kin');
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target); e.target.classList.add('kin-in');
    setTimeout(() => e.target.classList.add('kin-done'), e.target._letters.length * 40 + 1200);
  }), { threshold: 0.35 });
  for (const [sel, name] of Object.entries(fx)) document.querySelectorAll(sel).forEach(h => {
    if (h._letters) return;
    const label = h.textContent.trim().replace(/\s+/g, ' ');
    h._letters = splitHeading(h); h.setAttribute('aria-label', label);
    h.classList.add('kin-h'); h.dataset.fx = name; if (color) h.style.setProperty('--kc', color);
    if (waveOn && h.matches(waveOn)) wave(h, h._letters);
    io.observe(h);
  });
  const blocks = [...document.querySelectorAll(fill)].map(el => ({ el, words: splitFill(el) }));
  if (blocks.length) {
    let raf = 0;
    const paint = () => {
      raf = 0; const vh = innerHeight;
      for (const { el, words } of blocks) {
        const top = el.getBoundingClientRect().top; const p = clamp((vh * 0.9 - top) / (vh * 0.42));
        const n = words.length; words.forEach((w, i) => w.style.setProperty('--o', (0.2 + 0.8 * clamp(p * (n + 3) - i, 0, 1)).toFixed(2)));
      }
    };
    const req = () => { if (!raf) raf = requestAnimationFrame(paint); };
    addEventListener('scroll', req, { passive: true }); addEventListener('resize', req); paint();
  }
  if (magnetic && fine) document.querySelectorAll(magnetic).forEach(magnet);
}
