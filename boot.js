// Carregado antes de tudo (no <head>): aplica o tema salvo e mostra erros de carregamento.
// Fica num arquivo separado porque a política de segurança (CSP) do site bloqueia scripts embutidos.
(function () {
  try {
    var t = localStorage.getItem('mf_theme');
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  } catch (e) { /* ignora */ }
  // Se algo falhar ao carregar, mostra o motivo em vez de ficar em "Carregando…"
  window.addEventListener('error', function (e) {
    var box = document.getElementById('screen-loading');
    var msg = document.getElementById('loading-msg');
    if (!box || box.hidden || !msg) return;
    var what = e.message || ('não foi possível carregar ' + ((e.target && (e.target.src || e.target.href)) || 'um arquivo'));
    msg.textContent = 'Erro ao abrir o site: ' + what + '. Recarregue a página (Ctrl+F5 no PC).';
  }, true);
})();
