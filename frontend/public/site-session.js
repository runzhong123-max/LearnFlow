/* Shared presentation only. Caddy and the existing auth API enforce access. */
(() => {
  const hosts = ['learnflow.club', 'learn.learnflow.club', 'roles.learnflow.club', 'graphs.learnflow.club', 'w2ltask.learnflow.club'];
  if (!hosts.includes(location.hostname) || document.getElementById('site-account-status')) return;
  const login = () => {
    const destination = new URL(location.href);
    const token = new URLSearchParams(destination.hash.slice(1)).get('role_token') || '';
    const carry = token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
    if (carry) destination.hash = '';
    return 'https://learn.learnflow.club/login?return_to=' + encodeURIComponent(destination.href) + (carry ? '#' + new URLSearchParams({role_token:token}) : '');
  };
  const bar = document.createElement('nav');
  bar.id = 'site-account-status';
  bar.setAttribute('aria-label', '统一账号状态');
  bar.style.cssText = 'position:fixed;bottom:12px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:12px;padding:10px 16px;border:1px solid #cee0d7;border-radius:14px;background:#fffffff5;color:#174633;box-shadow:0 3px 16px #173c2515;font:13px system-ui;max-width:calc(100vw - 32px);box-sizing:border-box';
  const home = document.createElement('a'); home.href = 'https://learnflow.club/'; home.textContent = '比赛成果';
  const status = document.createElement('span'); status.textContent = '正在检查登录…'; status.setAttribute('aria-live', 'polite');
  const action = document.createElement('button'); action.textContent = '登录'; action.type = 'button';
  action.style.cssText = 'cursor:pointer;border:0;background:#087653;color:white;border-radius:7px;padding:6px 12px';
  bar.append(home, status, action); document.body.append(bar);
  let authenticated = false, busy = false, checking = false, learnerId;
  async function check() {
    if (checking || busy) return;
    checking = true;
    try {
      const response = await fetch('/api/auth/status', {credentials:'same-origin', cache:'no-store'});
      if (!response.ok) throw new Error('status');
      const account = await response.json();
      if (account.authenticated && learnerId !== undefined && learnerId !== account.learner_id) {
        location.reload(); return;
      }
      if (account.authenticated) learnerId = account.learner_id;
      authenticated = account.authenticated === true;
      status.textContent = authenticated ? `已登录 · ${account.display_name || account.username}` : '未登录';
      action.textContent = authenticated ? '退出登录' : '登录';
      if (!authenticated && location.pathname !== '/login') location.replace(login());
    } catch {
      status.textContent = '连接暂不可用，正在重试';
      // An outage is not evidence that a session has been revoked.
    } finally { checking = false; }
  }
  action.onclick = async () => {
    if (!authenticated) { location.assign(login()); return; }
    busy = true; action.disabled = true;
    try {
      const csrf = await fetch('/api/auth/csrf', {credentials:'same-origin', cache:'no-store'});
      if (!csrf.ok) throw new Error('csrf');
      const result = await fetch('/api/auth/logout', {method:'POST', credentials:'same-origin', headers:{'X-CSRF-Token':(await csrf.json()).csrf_token}});
      if (!result.ok) throw new Error('logout');
      location.replace(login());
    } catch { status.textContent = '退出失败，请重试'; }
    finally { busy = false; action.disabled = false; }
  };
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', check);
  setInterval(() => { if (!document.hidden) void check(); }, 60000);
  check();
})();
