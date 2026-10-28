/* Minhas Finanças — site estático que salva os dados numa planilha no Google Drive do usuário.
 * Login: OAuth 2.0 do Google (fluxo por redirecionamento, sem servidor).
 * Permissão: drive.file — o site só enxerga os arquivos que ele mesmo criou.
 * Modo demonstração: abra o site com ?demo no final do endereço.
 */
(function () {
  'use strict';

  // ---------- Configuração ----------
  const CFG = window.APP_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has('demo');
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const TAB_TX = 'Lancamentos';
  const TAB_CAT = 'Categorias';
  const HEAD_TX = ['ID', 'Data', 'Tipo', 'Descricao', 'Categoria', 'Valor', 'CriadoEm'];
  const HEAD_CAT = ['Nome', 'Tipo', 'Cor'];
  const APP_TAG = 'minhas-financas';
  const DEFAULT_CATS = [
    ['Alimentação', 'Despesa', '#e76f51'],
    ['Moradia', 'Despesa', '#264653'],
    ['Transporte', 'Despesa', '#2a9d8f'],
    ['Saúde', 'Despesa', '#e9c46a'],
    ['Educação', 'Despesa', '#8ab17d'],
    ['Lazer', 'Despesa', '#f4a261'],
    ['Compras', 'Despesa', '#9b5de5'],
    ['Contas', 'Despesa', '#457b9d'],
    ['Outros', 'Despesa', '#8d99ae'],
    ['Salário', 'Receita', '#2a9d8f'],
    ['Rendimentos', 'Receita', '#43aa8b'],
    ['Outras receitas', 'Receita', '#90be6d'],
  ];

  // ---------- Utilitários ----------
  function safeStore(getter) {
    return {
      get(k) { try { return getter().getItem(k); } catch (e) { return null; } },
      set(k, v) { try { getter().setItem(k, v); } catch (e) { /* ignora */ } },
      del(k) { try { getter().removeItem(k); } catch (e) { /* ignora */ } },
    };
  }
  const ls = safeStore(() => window.localStorage);
  const ss = safeStore(() => window.sessionStorage);

  const $ = (s) => document.querySelector(s);
  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmt = (n) => BRL.format(n || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const isoFromParts = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const todayISO = () => { const d = new Date(); return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // Datas no Sheets são "números de série" (dias desde 30/12/1899)
  const EPOCH = Date.UTC(1899, 11, 30);
  function isoToSerial(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);
  }
  function serialToISO(n) {
    const dt = new Date(EPOCH + Math.floor(n) * 86400000);
    return isoFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function toISO(v) {
    if (typeof v === 'number') return serialToISO(v);
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return isoFromParts(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return isoFromParts(+m[3], +m[2], +m[1]);
    return '';
  }
  // Aceita "1.234,56", "1234,56", "1234.56", "R$ 12"
  function parseValor(v) {
    if (typeof v === 'number') return v;
    let s = String(v || '').replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Autenticação ----------
  class AuthError extends Error {}

  const Auth = {
    token() {
      const t = ls.get('mf_token');
      const exp = Number(ls.get('mf_token_exp') || 0);
      return t && exp > Date.now() + 60000 ? t : null;
    },
    save(token, expiresIn) {
      ls.set('mf_token', token);
      ls.set('mf_token_exp', String(Date.now() + Number(expiresIn || 3600) * 1000));
    },
    clear() { ls.del('mf_token'); ls.del('mf_token_exp'); },
    redirect(silent) {
      const state = uid();
      ss.set('mf_state', state);
      if (silent) ss.set('mf_silent_at', String(Date.now()));
      const p = new URLSearchParams({
        client_id: CFG.CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'token',
        scope: SCOPE,
        include_granted_scopes: 'true',
        state,
      });
      if (silent) p.set('prompt', 'none');
      location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
    },
    // Evita loop: no máximo uma renovação silenciosa por minuto
    canSilent() { return Date.now() - Number(ss.get('mf_silent_at') || 0) > 60000; },
    // Lê o retorno do Google (#access_token=... ou #error=...)
    consumeHash() {
      const h = location.hash.slice(1);
      if (!/(^|&)(access_token|error)=/.test(h)) return null;
      const p = new URLSearchParams(h);
      history.replaceState(null, '', location.pathname + location.search);
      const expected = ss.get('mf_state');
      ss.del('mf_state');
      if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
      if (p.get('error')) return { error: p.get('error') };
      if (!(p.get('scope') || '').includes('drive.file')) return { error: 'scope_denied' };
      this.save(p.get('access_token'), p.get('expires_in'));
      return { ok: true };
    },
    async logout() {
      const t = ls.get('mf_token');
      this.clear();
      if (!t) return;
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'token=' + encodeURIComponent(t),
        });
      } catch (e) { /* ignora */ }
    },
  };

  async function api(url, opts = {}) {
    const token = Auth.token();
    if (!token) throw new AuthError('sem token');
    const headers = { Authorization: 'Bearer ' + token };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (res.status === 401) { Auth.clear(); throw new AuthError('expirado'); }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) { /* ignora */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  // ---------- Banco de dados: Google Sheets ----------
  const SheetsDB = {
    id: null,
    tabIds: {},

    async init(progress) {
      let id = ls.get('mf_sheet_id');
      if (id) {
        try { await this.loadMeta(id); return; }
        catch (e) { if (e instanceof AuthError) throw e; ls.del('mf_sheet_id'); }
      }
      progress('Procurando sua planilha…');
      const q = `appProperties has { key='app' and value='${APP_TAG}' } and trashed=false`;
      const r = await api(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&spaces=drive`);
      if (r.files && r.files.length) {
        id = r.files[0].id;
      } else {
        progress('Criando sua planilha no Google Drive…');
        id = await this.create();
      }
      await this.loadMeta(id);
    },

    async loadMeta(id) {
      const m = await api(`${SHEETS}/${id}?fields=sheets.properties(sheetId,title)`);
      const tabs = {};
      m.sheets.forEach((s) => { tabs[s.properties.title] = s.properties.sheetId; });
      if (!(TAB_TX in tabs) || !(TAB_CAT in tabs)) {
        throw new Error(`A planilha precisa ter as abas "${TAB_TX}" e "${TAB_CAT}" (não renomeie).`);
      }
      this.id = id;
      this.tabIds = tabs;
      ls.set('mf_sheet_id', id);
    },

    async create() {
      const s = await api(SHEETS, {
        method: 'POST',
        body: JSON.stringify({
          properties: { title: CFG.SPREADSHEET_NAME || 'Minhas Finanças', locale: 'pt_BR', timeZone: 'America/Sao_Paulo' },
          sheets: [
            { properties: { title: TAB_TX, gridProperties: { frozenRowCount: 1 } } },
            { properties: { title: TAB_CAT, gridProperties: { frozenRowCount: 1 } } },
          ],
        }),
      });
      const id = s.spreadsheetId;
      // Marca o arquivo para encontrá-lo depois (em outro aparelho, por exemplo)
      await api(`${DRIVE}/${id}`, { method: 'PATCH', body: JSON.stringify({ appProperties: { app: APP_TAG } }) });
      await api(`${SHEETS}/${id}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: [
            { range: `${TAB_TX}!A1:G1`, values: [HEAD_TX] },
            { range: `${TAB_CAT}!A1:C${DEFAULT_CATS.length + 1}`, values: [HEAD_CAT, ...DEFAULT_CATS] },
          ],
        }),
      });
      const txId = s.sheets[0].properties.sheetId;
      const catId = s.sheets[1].properties.sheetId;
      const bold = (sheetId) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      });
      const colFormat = (col, numberFormat) => ({
        repeatCell: {
          range: { sheetId: txId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
      await api(`${SHEETS}/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            bold(txId),
            bold(catId),
            colFormat(1, { type: 'DATE', pattern: 'dd/mm/yyyy' }),
            colFormat(5, { type: 'CURRENCY', pattern: '"R$" #,##0.00' }),
          ],
        }),
      });
      return id;
    },

    url(range, suffix) {
      return `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}${suffix || ''}`;
    },

    async listTx() {
      const r = await api(this.url(`${TAB_TX}!A2:G`, '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'));
      return (r.values || [])
        .filter((row) => row[0] !== undefined && row[0] !== '')
        .map((row) => ({
          id: String(row[0]),
          data: toISO(row[1]),
          tipo: row[2] === 'Receita' ? 'Receita' : 'Despesa',
          descricao: String(row[3] ?? ''),
          categoria: String(row[4] ?? ''),
          valor: Math.abs(parseValor(row[5])) || 0,
          criadoEm: String(row[6] ?? ''),
        }))
        .filter((t) => t.data);
    },

    toRow(t) {
      return [t.id, isoToSerial(t.data), t.tipo, t.descricao, t.categoria, t.valor, t.criadoEm];
    },

    async addTx(t) {
      await api(this.url(`${TAB_TX}!A:G`, ':append?valueInputOption=RAW'), {
        method: 'POST',
        body: JSON.stringify({ values: [this.toRow(t)] }),
      });
    },

    // Procura a linha atual pelo ID (as linhas podem mudar se a planilha for editada)
    async findRow(tab, key) {
      const r = await api(this.url(`${tab}!A:A`, '?valueRenderOption=UNFORMATTED_VALUE'));
      const idx = (r.values || []).findIndex((v, i) => i > 0 && String(v[0]) === String(key));
      if (idx < 1) throw new Error('registro não encontrado na planilha. Use "Atualizar dados" no menu.');
      return idx + 1;
    },

    async updateTx(t) {
      const row = await this.findRow(TAB_TX, t.id);
      await api(this.url(`${TAB_TX}!A${row}:G${row}`, '?valueInputOption=RAW'), {
        method: 'PUT',
        body: JSON.stringify({ values: [this.toRow(t)] }),
      });
    },

    async deleteRow(tab, key) {
      const row = await this.findRow(tab, key);
      await api(`${SHEETS}/${this.id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ deleteDimension: { range: { sheetId: this.tabIds[tab], dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }],
        }),
      });
    },

    deleteTx(id) { return this.deleteRow(TAB_TX, id); },

    async listCats() {
      const r = await api(this.url(`${TAB_CAT}!A2:C`));
      return (r.values || [])
        .filter((x) => x[0])
        .map((x) => ({
          nome: String(x[0]).trim(),
          tipo: x[1] === 'Receita' ? 'Receita' : 'Despesa',
          cor: /^#[0-9a-f]{6}$/i.test(x[2] || '') ? x[2] : '#8d99ae',
        }));
    },

    async addCat(c) {
      await api(this.url(`${TAB_CAT}!A:C`, ':append?valueInputOption=RAW'), {
        method: 'POST',
        body: JSON.stringify({ values: [[c.nome, c.tipo, c.cor]] }),
      });
    },

    deleteCat(nome) { return this.deleteRow(TAB_CAT, nome); },

    sheetUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; },
  };

  // ---------- Banco de dados: demonstração (memória) ----------
  const DemoDB = {
    tx: [],
    cats: DEFAULT_CATS.map(([nome, tipo, cor]) => ({ nome, tipo, cor })),
    async init() {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth() + 1;
      const d = (n) => isoFromParts(y, m, Math.min(n, now.getDate()));
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      const p = (n) => isoFromParts(py, pm, n);
      const rows = [
        [d(5), 'Receita', 'Salário', 'Salário', 5200],
        [d(1), 'Despesa', 'Prestação do apartamento', 'Moradia', 1350],
        [d(3), 'Despesa', 'Supermercado', 'Alimentação', 612.4],
        [d(8), 'Despesa', 'Gasolina', 'Transporte', 180],
        [d(10), 'Despesa', 'Conta de luz', 'Contas', 164.9],
        [d(12), 'Despesa', 'Farmácia', 'Saúde', 89.5],
        [d(15), 'Despesa', 'Cinema', 'Lazer', 70],
        [d(18), 'Despesa', 'Padaria', 'Alimentação', 38.2],
        [d(20), 'Receita', 'Rendimento poupança', 'Rendimentos', 42.15],
        [p(5), 'Receita', 'Salário', 'Salário', 5200],
        [p(2), 'Despesa', 'Supermercado', 'Alimentação', 540],
        [p(9), 'Despesa', 'Internet', 'Contas', 99.9],
      ];
      this.tx = rows.map(([data, tipo, descricao, categoria, valor]) => ({ id: uid(), data, tipo, descricao, categoria, valor, criadoEm: '' }));
    },
    async listTx() { return this.tx.map((t) => ({ ...t })); },
    async addTx(t) { this.tx.push({ ...t }); },
    async updateTx(t) { const i = this.tx.findIndex((x) => x.id === t.id); if (i >= 0) this.tx[i] = { ...t }; },
    async deleteTx(id) { this.tx = this.tx.filter((x) => x.id !== id); },
    async listCats() { return this.cats.map((c) => ({ ...c })); },
    async addCat(c) { this.cats.push({ ...c }); },
    async deleteCat(nome) { this.cats = this.cats.filter((c) => c.nome !== nome); },
    sheetUrl() { return '#'; },
  };

  const DB = DEMO ? DemoDB : SheetsDB;

  // ---------- Estado e telas ----------
  const state = { tx: [], cats: [], year: 0, month: 0, editing: null };

  function show(name) {
    ['loading', 'login', 'app'].forEach((n) => { $('#screen-' + n).hidden = n !== name; });
  }
  function loading(msg) { $('#loading-msg').textContent = msg || 'Carregando…'; show('loading'); }
  function setError(sel, msg) { const el = $(sel); el.textContent = msg || ''; el.hidden = !msg; }
  function showLogin(msg) { setError('#login-error', msg); show('login'); }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function onAuthLost() {
    if (Auth.canSilent()) {
      loading('Renovando acesso…');
      Auth.redirect(true);
    } else {
      showLogin('Sua sessão expirou. Entre novamente.');
    }
  }

  function catColor(nome) {
    const c = state.cats.find((x) => x.nome === nome);
    return c ? c.cor : '#8d99ae';
  }
  function monthTx() {
    const prefix = `${state.year}-${pad(state.month)}`;
    return state.tx.filter((t) => t.data.startsWith(prefix));
  }

  // ---------- Renderização ----------
  function render() {
    const label = new Date(state.year, state.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    $('#month-label').textContent = cap(label);

    const items = monthTx();
    let inc = 0;
    let out = 0;
    items.forEach((t) => { if (t.tipo === 'Receita') inc += t.valor; else out += t.valor; });
    $('#sum-in').textContent = fmt(inc);
    $('#sum-out').textContent = fmt(out);
    const bal = inc - out;
    const b = $('#sum-bal');
    b.textContent = fmt(bal);
    b.classList.toggle('neg', bal < 0);
    b.classList.toggle('pos', bal > 0);

    renderChart(items, out);
    renderList(items);
  }

  function renderChart(items, total) {
    const el = $('#chart');
    const by = new Map();
    items.filter((t) => t.tipo === 'Despesa').forEach((t) => {
      const k = t.categoria || 'Sem categoria';
      by.set(k, (by.get(k) || 0) + t.valor);
    });
    const rows = [...by].sort((a, b) => b[1] - a[1]);
    if (!rows.length) { el.innerHTML = '<p class="empty">Nenhuma despesa neste mês.</p>'; return; }
    const max = rows[0][1];
    el.innerHTML = rows.map(([cat, v]) => `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name"><i class="dot" style="background:${catColor(cat)}"></i>${esc(cat)}</span>
          <span class="bar-val">${fmt(v)}<small>${Math.round((v / total) * 100)}%</small></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (v / max) * 100)}%;background:${catColor(cat)}"></div></div>
      </div>`).join('');
  }

  function dayLabel(iso) {
    if (iso === todayISO()) return 'Hoje';
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (iso === isoFromParts(y.getFullYear(), y.getMonth() + 1, y.getDate())) return 'Ontem';
    const [yy, mm, dd] = iso.split('-').map(Number);
    return cap(new Date(yy, mm - 1, dd).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }));
  }

  function renderList(items) {
    const el = $('#list');
    if (!items.length) {
      el.innerHTML = '<p class="empty">Nenhum lançamento neste mês.<br>Toque em <strong>+</strong> para adicionar.</p>';
      return;
    }
    const sorted = [...items].sort((a, b) => b.data.localeCompare(a.data) || (b.criadoEm || '').localeCompare(a.criadoEm || ''));
    let html = '';
    let last = '';
    for (const t of sorted) {
      if (t.data !== last) { last = t.data; html += `<div class="day">${dayLabel(t.data)}</div>`; }
      const rec = t.tipo === 'Receita';
      html += `
        <button class="tx" type="button" data-id="${esc(t.id)}">
          <i class="dot" style="background:${catColor(t.categoria)}"></i>
          <span class="tx-main"><span class="tx-desc">${esc(t.descricao || t.categoria)}</span><span class="tx-cat">${esc(t.categoria)}</span></span>
          <span class="tx-val ${rec ? 'pos' : 'neg'}">${rec ? '+' : '−'} ${fmt(t.valor)}</span>
        </button>`;
    }
    el.innerHTML = html;
  }

  // ---------- Formulário de lançamento ----------
  function fillCatSelect(tipo, selected) {
    const cats = state.cats.filter((c) => c.tipo === tipo);
    let opts = cats.map((c) => `<option${c.nome === selected ? ' selected' : ''}>${esc(c.nome)}</option>`).join('');
    if (selected && !cats.some((c) => c.nome === selected)) opts = `<option selected>${esc(selected)}</option>` + opts;
    if (!opts) opts = '<option value="">(nenhuma categoria — crie no menu)</option>';
    $('#f-cat').innerHTML = opts;
  }

  function defaultDate() {
    const now = new Date();
    if (now.getFullYear() === state.year && now.getMonth() + 1 === state.month) return todayISO();
    return isoFromParts(state.year, state.month, 1);
  }

  function openTx(t) {
    state.editing = t || null;
    $('#tx-title').textContent = t ? 'Editar lançamento' : 'Novo lançamento';
    const tipo = t ? t.tipo : 'Despesa';
    $(tipo === 'Receita' ? '#tipo-rec' : '#tipo-desp').checked = true;
    $('#f-valor').value = t ? t.valor.toFixed(2).replace('.', ',') : '';
    $('#f-desc').value = t ? t.descricao : '';
    $('#f-data').value = t ? t.data : defaultDate();
    fillCatSelect(tipo, t ? t.categoria : null);
    $('#btn-del').hidden = !t;
    setError('#tx-error', '');
    busy(false);
    $('#dlg-tx').showModal();
    if (!t) setTimeout(() => $('#f-valor').focus(), 50);
  }

  function busy(on) {
    $('#btn-save').disabled = on;
    $('#btn-del').disabled = on;
    $('#btn-save').textContent = on ? 'Salvando…' : 'Salvar';
  }

  async function saveTx(e) {
    e.preventDefault();
    const tipo = document.querySelector('input[name="tipo"]:checked').value;
    const valor = parseValor($('#f-valor').value);
    const categoria = $('#f-cat').value;
    const data = $('#f-data').value;
    const descricao = $('#f-desc').value.trim();
    if (!(valor > 0)) return setError('#tx-error', 'Informe um valor maior que zero.');
    if (!categoria) return setError('#tx-error', 'Escolha uma categoria.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return setError('#tx-error', 'Informe a data.');
    const ed = state.editing;
    const t = {
      id: ed ? ed.id : uid(),
      tipo,
      valor: Math.round(valor * 100) / 100,
      descricao: descricao || categoria,
      categoria,
      data,
      criadoEm: ed && ed.criadoEm ? ed.criadoEm : new Date().toISOString(),
    };
    await persist(t, !!ed);
  }

  async function persist(t, isEdit) {
    busy(true);
    try {
      if (isEdit) await DB.updateTx(t); else await DB.addTx(t);
      if (isEdit) state.tx = state.tx.map((x) => (x.id === t.id ? t : x));
      else state.tx.push(t);
      if ($('#dlg-tx').open) $('#dlg-tx').close();
      render();
      toast(isEdit ? 'Lançamento atualizado' : 'Lançamento salvo');
    } catch (err) {
      if (err instanceof AuthError) {
        // Guarda o lançamento e salva automaticamente depois de renovar o acesso
        ss.set('mf_pending', JSON.stringify({ t, isEdit }));
        return onAuthLost();
      }
      console.error(err);
      setError('#tx-error', 'Não foi possível salvar: ' + err.message);
      if (!$('#dlg-tx').open) toast('Não foi possível salvar: ' + err.message);
    } finally {
      busy(false);
    }
  }

  async function deleteTx() {
    const t = state.editing;
    if (!t || !confirm('Excluir este lançamento?')) return;
    busy(true);
    try {
      await DB.deleteTx(t.id);
      state.tx = state.tx.filter((x) => x.id !== t.id);
      $('#dlg-tx').close();
      render();
      toast('Lançamento excluído');
    } catch (err) {
      if (err instanceof AuthError) return onAuthLost();
      setError('#tx-error', 'Não foi possível excluir: ' + err.message);
    } finally {
      busy(false);
    }
  }

  // ---------- Categorias ----------
  function renderCats() {
    const group = (tipo, titulo) => {
      const cs = state.cats.filter((c) => c.tipo === tipo);
      return `<h3>${titulo}</h3>` + (cs.length
        ? cs.map((c) => `
          <div class="cat-item">
            <i class="dot" style="background:${c.cor}"></i><span>${esc(c.nome)}</span>
            <button class="icon-btn small" type="button" data-del-cat="${esc(c.nome)}" aria-label="Excluir ${esc(c.nome)}">✕</button>
          </div>`).join('')
        : '<p class="empty">Nenhuma.</p>');
    };
    $('#cats-list').innerHTML = group('Despesa', 'Despesas') + group('Receita', 'Receitas');
  }

  async function onAddCat(e) {
    e.preventDefault();
    const nome = $('#c-nome').value.trim();
    if (!nome) return;
    if (state.cats.some((c) => c.nome.toLowerCase() === nome.toLowerCase())) return toast('Essa categoria já existe');
    const c = { nome, tipo: $('#c-tipo').value, cor: $('#c-cor').value };
    try {
      await DB.addCat(c);
      state.cats.push(c);
      $('#c-nome').value = '';
      renderCats();
      toast('Categoria adicionada');
    } catch (err) {
      if (err instanceof AuthError) return onAuthLost();
      toast('Erro: ' + err.message);
    }
  }

  async function onDelCat(e) {
    const b = e.target.closest('[data-del-cat]');
    if (!b) return;
    const nome = b.dataset.delCat;
    if (!confirm(`Excluir a categoria "${nome}"? Os lançamentos já feitos continuam com esse nome.`)) return;
    try {
      await DB.deleteCat(nome);
      state.cats = state.cats.filter((c) => c.nome !== nome);
      renderCats();
      render();
    } catch (err) {
      if (err instanceof AuthError) return onAuthLost();
      toast('Erro: ' + err.message);
    }
  }

  // ---------- Fluxo principal ----------
  async function loadData() {
    const [tx, cats] = await Promise.all([DB.listTx(), DB.listCats()]);
    state.tx = tx;
    state.cats = cats;
    render();
  }

  function shiftMonth(n) {
    let m = state.month + n;
    let y = state.year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.month = m;
    state.year = y;
    render();
  }

  function bindUI() {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;

    $('#btn-login').addEventListener('click', () => Auth.redirect(false));
    $('#btn-prev').addEventListener('click', () => shiftMonth(-1));
    $('#btn-next').addEventListener('click', () => shiftMonth(1));
    $('#month-label').addEventListener('click', () => {
      const d = new Date();
      state.year = d.getFullYear();
      state.month = d.getMonth() + 1;
      render();
    });
    $('#btn-add').addEventListener('click', () => openTx(null));
    $('#list').addEventListener('click', (e) => {
      const b = e.target.closest('.tx');
      if (!b) return;
      const t = state.tx.find((x) => x.id === b.dataset.id);
      if (t) openTx(t);
    });
    document.querySelectorAll('input[name="tipo"]').forEach((r) => {
      r.addEventListener('change', () => fillCatSelect(r.value, null));
    });
    $('#form-tx').addEventListener('submit', saveTx);
    $('#btn-del').addEventListener('click', deleteTx);

    $('#btn-menu').addEventListener('click', () => $('#dlg-menu').showModal());
    $('#menu-sheet').addEventListener('click', () => $('#dlg-menu').close());
    $('#menu-cats').addEventListener('click', () => {
      $('#dlg-menu').close();
      renderCats();
      $('#dlg-cats').showModal();
    });
    $('#menu-reload').addEventListener('click', async () => {
      $('#dlg-menu').close();
      try { await loadData(); toast('Dados atualizados'); }
      catch (err) { if (err instanceof AuthError) return onAuthLost(); toast('Erro: ' + err.message); }
    });
    $('#menu-logout').addEventListener('click', async () => {
      $('#dlg-menu').close();
      await Auth.logout();
      ls.del('mf_had_session');
      state.tx = [];
      showLogin('');
    });
    $('#cats-list').addEventListener('click', onDelCat);
    $('#form-cat').addEventListener('submit', onAddCat);

    document.querySelectorAll('dialog').forEach((d) => {
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // clique fora fecha
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });
  }

  async function start() {
    loading('Conectando ao Google Drive…');
    try {
      await DB.init(loading);
      await loadData();
      $('#menu-sheet').href = DB.sheetUrl();
      $('#menu-sheet').hidden = DEMO;
      $('#menu-logout').hidden = DEMO;
      $('#demo-banner').hidden = !DEMO;
      show('app');
      const pending = ss.get('mf_pending');
      if (pending) {
        ss.del('mf_pending');
        try { const p = JSON.parse(pending); await persist(p.t, p.isEdit); } catch (e) { /* ignora */ }
      }
    } catch (err) {
      if (err instanceof AuthError) return onAuthLost();
      console.error(err);
      showLogin('Erro ao carregar: ' + err.message);
    }
  }

  function boot() {
    bindUI();
    if (DEMO) return start();

    if (!CFG.CLIENT_ID) return showLogin('Configure o CLIENT_ID no arquivo config.js.');

    const r = Auth.consumeHash();
    if (r && r.error) {
      const silentErrors = ['interaction_required', 'login_required', 'consent_required', 'account_selection_required'];
      if (silentErrors.includes(r.error)) return showLogin('');
      if (r.error === 'access_denied') return showLogin('Você não autorizou o acesso. Para usar o site, é preciso permitir.');
      if (r.error === 'scope_denied') return showLogin('Marque a permissão do Google Drive na tela do Google para o site funcionar.');
      return showLogin('Erro no login: ' + r.error);
    }
    if (r && r.ok) ls.set('mf_had_session', '1');

    if (Auth.token()) return start();
    if (ls.get('mf_had_session')) return onAuthLost(); // já usou antes: renova sem pedir clique
    showLogin('');
  }

  boot();
})();
