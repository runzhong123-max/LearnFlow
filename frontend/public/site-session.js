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
  let authenticated = false, checking = false, learnerId;
  async function check() {
    if (checking) return;
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
      if (!authenticated && location.pathname !== '/login') {
        const expiry = new CustomEvent('learnflow:session-expired', {cancelable:true, detail:{loginUrl:login()}});
        if (window.dispatchEvent(expiry)) location.replace(login());
      }
    } catch {
      // An outage is not evidence that a session has been revoked.
    } finally { checking = false; }
  }
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', check);
  setInterval(() => { if (!document.hidden) void check(); }, 60000);
  check();
})();
