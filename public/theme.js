// Runs before first paint so there is no flash of the wrong theme. Kept as a separate file because the CSP forbids inline scripts.
// Dark is the default; only an explicit choice (saved by the theme button) switches to light.
try { if (localStorage.getItem('ag-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* storage blocked: stay dark */ }
