(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const getParam = (name) => params.get(name) || hashParams.get(name);
  const shell = document.querySelector('.auth-shell');
  const message = document.querySelector('#auth-message');
  const closeButton = document.querySelector('#close-button');

  const allowedOrigin = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && (url.hostname === 'vine.amazon.com' || url.hostname === 'www.amazon.com')
        && url.origin === value;
    } catch {
      return false;
    }
  };

  const fail = (text) => {
    shell.classList.add('error');
    message.textContent = text;
    closeButton.hidden = false;
  };

  closeButton.addEventListener('click', () => window.close());

  const origin = getParam('origin');
  const state = getParam('state');
  const code = getParam('code');
  const error = getParam('error_description') || getParam('error');

  if (!allowedOrigin(origin) || !/^[A-Za-z0-9_-]{20,128}$/.test(state || '')) {
    fail('The sign-in return address is invalid. Close this window and try again from Vine Tools.');
    return;
  }

  if (!window.opener) {
    const fallback = new URL('/vine/vine-items', origin);
    fallback.hash = new URLSearchParams({
      vine_sync_auth: '1',
      state,
      ...(code ? { code } : {}),
      ...(error ? { error } : {})
    }).toString();
    window.location.replace(fallback.href);
    return;
  }

  window.opener.postMessage({
    type: 'vine-supabase-auth',
    state,
    code,
    error: error || null
  }, origin);

  if (error || !code) {
    fail(error || 'Supabase did not return an authorization code. Please try again.');
    return;
  }

  shell.classList.add('complete');
  message.textContent = 'Connected. Returning you to Vine Tools…';
  setTimeout(() => window.close(), 900);
})();
