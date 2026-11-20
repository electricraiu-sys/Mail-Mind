import { $ } from '../dom';

const tabId = Number(new URLSearchParams(location.search).get('tabId'));

$('#back').addEventListener('click', () => window.close());
$('#send').addEventListener('click', async () => {
  const btn = $('#send') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const r = await messenger.runtime.sendMessage({ type: 'sendAnyway', tabId });
  if (r?.ok) window.close();
  else {
    const err = $('#err');
    err.textContent = `Couldn't send: ${r?.error ?? 'unknown error'}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Send anyway';
  }
});
