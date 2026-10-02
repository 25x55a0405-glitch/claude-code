const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A tiny sign-in page for servers protected with SKYS_PASSWORD. */
export function loginPage(agentName: string, webUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ${esc(agentName)}</title>
<style>
:root{color-scheme:dark light;--bg:#070b18;--card:#0f1530;--text:#e8ecff;--muted:#9aa4c7;--accent:linear-gradient(135deg,#5ab8ff,#8a6bff)}
@media (prefers-color-scheme:light){:root{--bg:#eef3ff;--card:#fff;--text:#0d1330;--muted:#5a648a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--card);border-radius:20px;padding:28px;display:grid;gap:14px;box-shadow:0 20px 60px #0003}
h1{margin:0;font-size:22px}p{margin:0;color:var(--muted);font-size:14px}
input{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid #8884;background:transparent;color:inherit}
button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:12px;color:#fff;background:var(--accent);cursor:pointer}
.err{color:#ff6b6b;min-height:1.5em}
</style></head><body>
<form id="f"><h1>${esc(agentName)}</h1><p>Enter your password to continue.</p>
<input id="p" type="password" autocomplete="current-password" placeholder="Password" required autofocus>
<button>Sign in</button><div class="err" id="e" role="alert"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await fetch('/api/v1/session', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('p').value }) });
  if (r.ok) location.href = ${JSON.stringify(webUrl)};
  else document.getElementById('e').textContent = ((await r.json().catch(() => null))?.error?.message) || 'Sign-in failed';
});
</script></body></html>`;
}
