/* Minhas Finanças — site estático que salva os dados numa planilha no Google Drive do usuário.
 * Login: OAuth 2.0 do Google (fluxo por redirecionamento, sem servidor).
 * Permissão: drive.file — o site só enxerga os arquivos que ele mesmo criou.
 * Modo demonstração: abra o site com ?demo no final do endereço.
 */
(function () {
  'use strict';

  // ================= Configuração =================
  const CFG = window.APP_CONFIG || {};
  const DEMO = CFG.DEMO === true || new URLSearchParams(location.search).has('demo');
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const APP_TAG = 'minhas-financas';

  // Estrutura da planilha. As colunas são lidas pelo NOME do cabeçalho,
  // então colunas novas são acrescentadas no fim sem quebrar planilhas antigas.
  const SCHEMA = {
    Lancamentos: {
      key: 'ID',
      cols: ['ID', 'Data', 'Hora', 'Tipo', 'Descricao', 'Categoria', 'Valor', 'Cartao', 'Fatura', 'Parcela', 'Parcelas', 'Grupo', 'Fixa', 'CriadoEm'],
      date: ['Data'],
      money: ['Valor'],
    },
    Categorias: { key: 'Nome', cols: ['Nome', 'Tipo', 'Cor'] },
    Cartoes: { key: 'ID', cols: ['ID', 'Nome', 'Fechamento', 'Vencimento', 'Limite', 'Cor'], money: ['Limite'] },
    Fixas: { key: 'ID', cols: ['ID', 'Tipo', 'Descricao', 'Categoria', 'Valor', 'Dia', 'Cartao', 'Inicio', 'Fim', 'Variavel', 'GeradoAte'], money: ['Valor'] },
  };
  const TABLES = Object.keys(SCHEMA);

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
  ].map(([Nome, Tipo, Cor]) => ({ Nome, Tipo, Cor }));

  // ================= Utilitários =================
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
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmt = (n) => BRL.format(n || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const round2 = (n) => Math.round(n * 100) / 100;

  const isoFromParts = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const ymOfDate = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
  const todayISO = () => { const d = new Date(); return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const isYM = (s) => /^\d{4}-\d{2}$/.test(s || '');

  function addMonths(ym, n) {
    let [y, m] = ym.split('-').map(Number);
    m += n;
    y += Math.floor((m - 1) / 12);
    m = (((m - 1) % 12) + 12) % 12 + 1;
    return `${y}-${pad(m)}`;
  }
  function dateInMonth(ym, day) {
    const [y, m] = ym.split('-').map(Number);
    return isoFromParts(y, m, Math.min(Math.max(1, day), daysInMonth(y, m)));
  }
  function monthName(ym) {
    const [y, m] = ym.split('-').map(Number);
    return cap(new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }));
  }
  function monthShort(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '') + '/' + y;
  }

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
  function normYM(v) {
    const s = String(v ?? '').trim();
    const m = s.match(/^(\d{4})-(\d{1,2})/);
    return m ? `${m[1]}-${pad(+m[2])}` : '';
  }
  function normHora(v) {
    if (typeof v === 'number') {
      const min = Math.round((v % 1) * 1440) % 1440;
      return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    }
    const m = String(v ?? '').match(/^(\d{1,2}):(\d{2})/);
    return m ? `${pad(+m[1])}:${m[2]}` : '';
  }
  // Aceita "1.234,56", "1234,56", "1234.56", "R$ 12"
  function parseValor(v) {
    if (typeof v === 'number') return v;
    let s = String(v || '').replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const num = (v) => { const n = parseValor(v); return Number.isFinite(n) ? n : 0; };
  const dayNum = (v, def) => { const n = Math.round(num(v)); return n >= 1 && n <= 31 ? n : def; };
  const hex = (v, def) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : def);
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function colLetter(i) {
    let s = '';
    i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  // ================= Autenticação =================
  class AuthError extends Error {}

  const Auth = {
    token() {
      const t = ls.get('mf_token');
      const exp = Number(ls.get('mf_token_exp') || 0);
      return t && exp > Date.now() + 60000 ? t : null;
    },
    minutesLeft() { return (Number(ls.get('mf_token_exp') || 0) - Date.now()) / 60000; },
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
    canSilent() { return Date.now() - Number(ss.get('mf_silent_at') || 0) > 60000; },
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
      throw new Error(msg);
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });

  // ================= Banco de dados: Google Sheets =================
  const SheetsDB = {
    id: null,
    tabIds: {},
    headers: {},

    async init(progress) {
      let id = ls.get('mf_sheet_id');
      if (id) {
        try { await this.open(id, progress); return; }
        catch (e) { if (e instanceof AuthError) throw e; console.warn(e); ls.del('mf_sheet_id'); }
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
      await this.open(id, progress);
    },

    async create() {
      const s = await post(SHEETS, {
        properties: { title: CFG.SPREADSHEET_NAME || 'Minhas Finanças', locale: 'pt_BR', timeZone: 'America/Sao_Paulo' },
        sheets: TABLES.map((t) => ({ properties: { title: t, gridProperties: { frozenRowCount: 1 } } })),
      });
      // Marca o arquivo para encontrá-lo depois (em outro aparelho, por exemplo)
      await api(`${DRIVE}/${s.spreadsheetId}`, { method: 'PATCH', body: JSON.stringify({ appProperties: { app: APP_TAG } }) });
      return s.spreadsheetId;
    },

    // Abre a planilha e garante que todas as abas e colunas existem
    async open(id, progress) {
      const m = await api(`${SHEETS}/${id}?fields=sheets.properties(sheetId,title)`);
      const tabs = {};
      m.sheets.forEach((s) => { tabs[s.properties.title] = s.properties.sheetId; });
      const missingTabs = TABLES.filter((t) => !(t in tabs));
      if (missingTabs.length) {
        if (progress) progress('Atualizando a estrutura da planilha…');
        const r = await post(`${SHEETS}/${id}:batchUpdate`, {
          requests: missingTabs.map((t) => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } })),
        });
        r.replies.forEach((rep) => { const p = rep.addSheet.properties; tabs[p.title] = p.sheetId; });
      }
      this.id = id;
      this.tabIds = tabs;

      const qs = TABLES.map((t) => 'ranges=' + encodeURIComponent(`${t}!1:1`)).join('&');
      const hb = await api(`${SHEETS}/${id}/values:batchGet?${qs}`);
      const writes = [];
      const changed = [];
      let seedCats = false;
      TABLES.forEach((t, i) => {
        const cur = (((hb.valueRanges[i] || {}).values || [])[0] || []).map((h) => String(h).trim());
        const add = SCHEMA[t].cols.filter((c) => !cur.includes(c));
        const all = cur.concat(add);
        this.headers[t] = all;
        if (add.length) {
          writes.push({ range: `${t}!A1:${colLetter(all.length - 1)}1`, values: [all] });
          changed.push(t);
        }
        if (t === 'Categorias' && cur.length === 0) seedCats = true;
      });
      if (writes.length) await post(`${SHEETS}/${id}/values:batchUpdate`, { valueInputOption: 'RAW', data: writes });
      if (seedCats) await this.add('Categorias', DEFAULT_CATS);
      if (changed.length) await this.applyFormats(changed);
      ls.set('mf_sheet_id', id);
    },

    async applyFormats(tables) {
      const requests = [];
      const colFmt = (sheetId, i, numberFormat) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: { numberFormat } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
      tables.forEach((t) => {
        const sheetId = this.tabIds[t];
        const h = this.headers[t];
        const sc = SCHEMA[t];
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        });
        (sc.date || []).forEach((c) => { const i = h.indexOf(c); if (i >= 0) requests.push(colFmt(sheetId, i, { type: 'DATE', pattern: 'dd/mm/yyyy' })); });
        (sc.money || []).forEach((c) => { const i = h.indexOf(c); if (i >= 0) requests.push(colFmt(sheetId, i, { type: 'CURRENCY', pattern: '"R$" #,##0.00' })); });
      });
      if (requests.length) await post(`${SHEETS}/${this.id}:batchUpdate`, { requests });
    },

    url(range, suffix) { return `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}${suffix || ''}`; },

    async list(t) {
      const h = this.headers[t];
      const sc = SCHEMA[t];
      const r = await api(this.url(`${t}!A2:${colLetter(h.length - 1)}`, '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'));
      const ki = h.indexOf(sc.key);
      return (r.values || [])
        .filter((row) => row[ki] !== undefined && row[ki] !== '')
        .map((row) => {
          const o = {};
          h.forEach((c, i) => {
            let v = row[i] === undefined ? '' : row[i];
            if ((sc.date || []).includes(c)) v = toISO(v);
            if (c) o[c] = v;
          });
          return o;
        });
    },

    toRow(t, rec) {
      const sc = SCHEMA[t];
      return this.headers[t].map((c) => {
        let v = rec[c];
        if (v === undefined || v === null) v = '';
        if ((sc.date || []).includes(c) && v) v = isoToSerial(v);
        return v;
      });
    },

    async add(t, recs) {
      if (!recs.length) return;
      await post(this.url(`${t}!A1`, ':append?valueInputOption=RAW'), { values: recs.map((r) => this.toRow(t, r)) });
    },

    // Linhas atuais de cada chave (as linhas mudam se a planilha for editada)
    async keyRows(t, keys) {
      const L = colLetter(this.headers[t].indexOf(SCHEMA[t].key));
      const r = await api(this.url(`${t}!${L}:${L}`, '?valueRenderOption=UNFORMATTED_VALUE'));
      const set = new Set(keys.map(String));
      const rows = [];
      (r.values || []).forEach((v, i) => { if (i > 0 && v && set.has(String(v[0]))) rows.push(i + 1); });
      return rows;
    },

    async update(t, rec) {
      const [row] = await this.keyRows(t, [rec[SCHEMA[t].key]]);
      if (!row) throw new Error('registro não encontrado na planilha. Use "Atualizar dados" no menu.');
      const last = colLetter(this.headers[t].length - 1);
      await api(this.url(`${t}!A${row}:${last}${row}`, '?valueInputOption=RAW'), {
        method: 'PUT',
        body: JSON.stringify({ values: [this.toRow(t, rec)] }),
      });
    },

    async remove(t, keys) {
      const rows = (await this.keyRows(t, keys)).sort((a, b) => b - a);
      if (!rows.length) return;
      await post(`${SHEETS}/${this.id}:batchUpdate`, {
        requests: rows.map((r) => ({ deleteDimension: { range: { sheetId: this.tabIds[t], dimension: 'ROWS', startIndex: r - 1, endIndex: r } } })),
      });
    },

    sheetUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; },
  };

  // ================= Banco de dados: demonstração (memória) =================
  const DemoDB = {
    data: {},
    async init() { this.data = seedDemo(); },
    async list(t) { return (this.data[t] || []).map((r) => ({ ...r })); },
    async add(t, recs) { recs.forEach((r) => this.data[t].push({ ...r })); },
    async update(t, rec) {
      const k = SCHEMA[t].key;
      const i = this.data[t].findIndex((r) => String(r[k]) === String(rec[k]));
      if (i >= 0) this.data[t][i] = { ...rec };
    },
    async remove(t, keys) {
      const k = SCHEMA[t].key;
      const s = new Set(keys.map(String));
      this.data[t] = this.data[t].filter((r) => !s.has(String(r[k])));
    },
    sheetUrl() { return '#'; },
  };

  const DB = DEMO ? DemoDB : SheetsDB;

  // ================= Conversão registro ⇄ objeto =================
  function txFrom(r) {
    return {
      id: String(r.ID),
      data: r.Data || '',
      hora: normHora(r.Hora),
      tipo: r.Tipo === 'Receita' ? 'Receita' : 'Despesa',
      descricao: String(r.Descricao ?? ''),
      categoria: String(r.Categoria ?? ''),
      valor: Math.abs(num(r.Valor)),
      cartao: String(r.Cartao ?? ''),
      fatura: normYM(r.Fatura),
      parcela: Math.round(num(r.Parcela)),
      parcelas: Math.round(num(r.Parcelas)),
      grupo: String(r.Grupo ?? ''),
      fixa: String(r.Fixa ?? ''),
      criadoEm: String(r.CriadoEm ?? ''),
      _r: r,
    };
  }
  function txTo(t) {
    return {
      ...(t._r || {}),
      ID: t.id, Data: t.data, Hora: t.hora || '', Tipo: t.tipo, Descricao: t.descricao, Categoria: t.categoria,
      Valor: t.valor, Cartao: t.cartao || '', Fatura: t.cartao ? t.fatura : '',
      Parcela: t.parcelas > 1 ? t.parcela : '', Parcelas: t.parcelas > 1 ? t.parcelas : '',
      Grupo: t.grupo || '', Fixa: t.fixa || '', CriadoEm: t.criadoEm || '',
    };
  }
  function cardFrom(r) {
    return {
      id: String(r.ID), nome: String(r.Nome ?? '') || 'Cartão',
      fech: dayNum(r.Fechamento, 1), venc: dayNum(r.Vencimento, 10),
      limite: num(r.Limite), cor: hex(r.Cor, '#7c3aed'), _r: r,
    };
  }
  function cardTo(c) {
    return { ...(c._r || {}), ID: c.id, Nome: c.nome, Fechamento: c.fech, Vencimento: c.venc, Limite: c.limite || '', Cor: c.cor };
  }
  function fixaFrom(r) {
    return {
      id: String(r.ID), tipo: r.Tipo === 'Receita' ? 'Receita' : 'Despesa',
      descricao: String(r.Descricao ?? ''), categoria: String(r.Categoria ?? ''),
      valor: Math.abs(num(r.Valor)), dia: dayNum(r.Dia, 1), cartao: String(r.Cartao ?? ''),
      inicio: normYM(r.Inicio), fim: normYM(r.Fim),
      variavel: /^(sim|s|true|1|x|verdadeiro)$/i.test(String(r.Variavel ?? '').trim()),
      geradoAte: normYM(r.GeradoAte), _r: r,
    };
  }
  function fixaTo(f) {
    return {
      ...(f._r || {}), ID: f.id, Tipo: f.tipo, Descricao: f.descricao, Categoria: f.categoria,
      Valor: f.valor, Dia: f.dia, Cartao: f.cartao || '', Inicio: f.inicio, Fim: f.fim || '',
      Variavel: f.variavel ? 'Sim' : 'Não', GeradoAte: f.geradoAte || '',
    };
  }
  function catFrom(r) {
    return { nome: String(r.Nome).trim(), tipo: r.Tipo === 'Receita' ? 'Receita' : 'Despesa', cor: hex(r.Cor, '#8d99ae') };
  }

  // ================= Regras do cartão =================
  // "Melhor dia de compra" = dia em que a fatura vira. Compras a partir dele vão para a fatura seguinte.
  // A fatura é identificada pelo mês do VENCIMENTO (aaaa-mm).
  function faturaDe(card, iso) {
    const [y, m, d] = iso.split('-').map(Number);
    let close = `${y}-${pad(m)}`;
    if (d >= Math.min(card.fech, daysInMonth(y, m))) close = addMonths(close, 1);
    return card.venc > card.fech ? close : addMonths(close, 1);
  }
  function faturaDatas(card, fatYm) {
    const vence = dateInMonth(fatYm, card.venc);
    const closeYm = card.venc > card.fech ? fatYm : addMonths(fatYm, -1);
    return { vira: dateInMonth(closeYm, card.fech), vence };
  }
  function faturaStatus(card, fatYm) {
    const { vira, vence } = faturaDatas(card, fatYm);
    const hoje = todayISO();
    if (hoje < vira) return { cls: 'open', txt: `Aberta · vira em ${ddmm(vira)}`, vence };
    if (hoje <= vence) return { cls: 'closed', txt: `Fechada · vence ${ddmm(vence)}`, vence };
    return { cls: 'past', txt: `Venceu em ${ddmm(vence)}`, vence };
  }
  function cardHint(fech, venc) {
    if (!(fech >= 1 && fech <= 31 && venc >= 1 && venc <= 31)) return '';
    const mesmo = venc > fech;
    const a = fech > 1
      ? `Compras até o dia ${fech - 1} entram na fatura que vence dia ${venc} ${mesmo ? 'do mesmo mês' : 'do mês seguinte'}. `
      : '';
    return a + `A partir do dia ${fech}, a compra vai para a fatura do mês seguinte.`;
  }
  function usedLimit(card) {
    const hoje = todayISO();
    return state.tx
      .filter((t) => t.cartao === card.id && t.tipo === 'Despesa' && t.fatura && faturaDatas(card, t.fatura).vence >= hoje)
      .reduce((s, t) => s + t.valor, 0);
  }

  // ================= Estado =================
  const state = {
    tx: [], cats: [], cards: [], fixas: [], ym: ymOfDate(new Date()), form: null, fat: null,
    tab: 'inicio', filter: 'todos',
  };

  const cardById = (id) => state.cards.find((c) => c.id === id) || null;
  const cardName = (id) => (cardById(id) || { nome: 'Cartão excluído' }).nome;
  const cardColor = (id) => (cardById(id) || { cor: '#8d99ae' }).cor;
  const catColor = (nome) => (state.cats.find((c) => c.nome === nome) || { cor: '#8d99ae' }).cor;
  const fixaAtiva = (f, ym) => (f.inicio || '0000-00') <= ym && (!f.fim || f.fim >= ym);

  // O que conta em cada mês: compras no cartão contam no mês do vencimento da fatura
  function contaNoMes(t, ym) {
    return t.cartao && t.fatura ? t.fatura === ym : t.data.slice(0, 7) === ym;
  }
  function monthData(ym) {
    const items = state.tx.filter((t) => contaNoMes(t, ym));
    // Previstos: fixos do mês ainda sem lançamento. Os de valor igual só entram aqui
    // em meses que ainda não foram lançados automaticamente (futuro ou dia não chegou).
    const prev = state.fixas.filter((f) => fixaAtiva(f, ym)
      && !state.tx.some((t) => t.fixa === `${f.id}|${ym}`)
      && (f.variavel || ym > (f.geradoAte || '')));
    return { items, prev };
  }

  // Lança sozinhos os fixos de valor igual cujo dia já chegou.
  // "GeradoAte" guarda o último mês lançado, para não recriar algo que você excluiu.
  async function autoLancarFixos() {
    const hoje = todayISO();
    const cur = ymOfDate(new Date());
    const novos = [];
    const alterados = [];
    state.fixas.forEach((f) => {
      if (f.variavel) return;
      let ym = f.geradoAte ? addMonths(f.geradoAte, 1) : (f.inicio || cur);
      if (ym < addMonths(cur, -24)) ym = addMonths(cur, -24);
      let last = f.geradoAte;
      for (; ym <= cur; ym = addMonths(ym, 1)) {
        if (!fixaAtiva(f, ym)) continue;
        const data = dateInMonth(ym, f.dia);
        if (data > hoje) break;
        const ref = `${f.id}|${ym}`;
        if (!state.tx.some((t) => t.fixa === ref)) {
          const card = cardById(f.cartao);
          novos.push({
            id: uid(), data, hora: '', tipo: f.tipo, descricao: f.descricao, categoria: f.categoria, valor: f.valor,
            cartao: f.cartao, fatura: card ? faturaDe(card, data) : '', parcela: 0, parcelas: 0, grupo: '',
            fixa: ref, criadoEm: new Date().toISOString(),
          });
        }
        last = ym;
      }
      if (last !== f.geradoAte) { f.geradoAte = last; alterados.push(f); }
    });
    if (novos.length) { await DB.add('Lancamentos', novos.map(txTo)); state.tx.push(...novos); }
    for (const f of alterados) await DB.update('Fixas', fixaTo(f));
    return novos.length;
  }

  // ================= Telas e avisos =================
  function show(name) { ['loading', 'login', 'app'].forEach((n) => { $('#screen-' + n).hidden = n !== name; }); }
  function loading(msg) { $('#loading-msg').textContent = msg || 'Carregando…'; show('loading'); }
  function setError(el, msg) { if (!el) return; el.textContent = msg || ''; el.hidden = !msg; }
  function showLogin(msg) { setError($('#login-error'), msg); show('login'); }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    const host = $$('dialog[open]').pop() || document.body; // aparece por cima de janelas abertas
    if (el.parentNode !== host) host.appendChild(el);
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function askConfirm(msg, okLabel) {
    return new Promise((resolve) => {
      const d = $('#dlg-confirm');
      $('#confirm-msg').textContent = msg;
      $('#confirm-ok').textContent = okLabel || 'Excluir';
      const done = (v) => {
        $('#confirm-ok').onclick = null;
        $('#confirm-cancel').onclick = null;
        d.onclose = null;
        if (d.open) d.close();
        resolve(v);
      };
      $('#confirm-ok').onclick = () => done(true);
      $('#confirm-cancel').onclick = () => done(false);
      d.onclose = () => done(false);
      d.showModal();
    });
  }

  function onAuthLost() {
    if (Auth.canSilent()) { loading('Renovando acesso…'); Auth.redirect(true); }
    else showLogin('Sua sessão expirou. Entre novamente.');
  }
  // Renova o acesso ANTES de abrir um formulário, para não perder o que for digitado
  function freshEnough() {
    if (DEMO || Auth.minutesLeft() > 10) return true;
    onAuthLost();
    return false;
  }

  function setBusy(on) {
    $$('dialog .btn-primary, dialog .btn-danger').forEach((b) => { b.disabled = on; });
  }
  // Executa uma gravação; em caso de erro mostra a mensagem dentro da janela
  async function run(fn, okMsg, dlg) {
    const errEl = dlg ? dlg.querySelector('.dlg-error') : null;
    setError(errEl, '');
    setBusy(true);
    try {
      await fn();
      if (dlg && dlg.open) dlg.close();
      render();
      refreshDialogs();
      if (okMsg) toast(okMsg);
      return true;
    } catch (err) {
      if (err instanceof AuthError) { onAuthLost(); return false; }
      console.error(err);
      if (errEl) setError(errEl, 'Não foi possível salvar: ' + err.message);
      else toast('Erro: ' + err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ================= Renderização principal =================
  function render() {
    const ym = state.ym;
    $('#month-label').textContent = monthName(ym);
    const { items, prev } = monthData(ym);

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

    const sp = $('#sum-prev');
    if (prev.length) {
      const pv = prev.reduce((s, f) => s + (f.tipo === 'Receita' ? f.valor : -f.valor), 0);
      sp.innerHTML = `Previsto com os fixos a confirmar: <strong>${fmt(bal + pv)}</strong>`;
      sp.hidden = false;
    } else sp.hidden = true;

    renderPrev(prev.filter((f) => f.variavel));
    renderCardsSummary(items);
    renderRecent();
    renderLanc();
    renderCatBars($('#chart'), items, 'Despesa', 'Nenhuma despesa neste mês.');
    renderCatBars($('#chart-rec'), items, 'Receita', 'Nenhuma receita neste mês.');
    renderEvo();
  }

  function renderPrev(prev) {
    $('#sec-prev').hidden = !prev.length;
    $('#prev-list').innerHTML = prev
      .sort((a, b) => a.dia - b.dia)
      .map((f) => {
        const rec = f.tipo === 'Receita';
        const sub = [`Dia ${f.dia}`, f.categoria, f.cartao ? cardName(f.cartao) : ''].filter(Boolean).join(' · ');
        return `
        <div class="tx prev-row" data-prev="${esc(f.id)}" role="button" tabindex="0">
          <i class="dot" style="background:${catColor(f.categoria)}"></i>
          <span class="tx-main"><span class="tx-desc">${esc(f.descricao)}</span><span class="tx-sub">${esc(sub)}</span></span>
          <span class="tx-right">
            <span class="tx-val ${rec ? 'pos' : 'neg'}">${rec ? '+' : '−'} ${fmt(f.valor)}</span>
            <button class="btn btn-soft btn-sm" type="button">Confirmar</button>
          </span>
        </div>`;
      }).join('');
  }

  function renderCardsSummary(items) {
    const el = $('#cards-sum');
    const ym = state.ym;
    const ids = state.cards.map((c) => c.id);
    items.forEach((t) => { if (t.cartao && t.fatura && !ids.includes(t.cartao)) ids.push(t.cartao); });
    if (!ids.length) {
      el.innerHTML = `<div class="empty-cta"><p>Cadastre seu cartão para ver as faturas de cada mês.</p>
        <button class="btn btn-soft" type="button" data-open="card-new">Cadastrar cartão</button></div>`;
      return;
    }
    const curYm = ymOfDate(new Date());
    el.innerHTML = ids.map((id) => {
      const card = cardById(id);
      const total = items.filter((t) => t.cartao === id).reduce((s, t) => s + (t.tipo === 'Receita' ? -t.valor : t.valor), 0);
      const st = card ? faturaStatus(card, ym) : { cls: 'past', txt: 'Cartão excluído' };
      // No mês atual, mostra também as próximas faturas (fechada aguardando pagamento e a aberta)
      let extra = '';
      if (card && ym === curYm) {
        const aberta = faturaDe(card, todayISO());
        for (let f = addMonths(ym, 1); f <= aberta; f = addMonths(f, 1)) {
          const tot2 = state.tx.filter((t) => t.cartao === id && t.fatura === f).reduce((s, t) => s + (t.tipo === 'Receita' ? -t.valor : t.valor), 0);
          const rot = f === aberta ? 'aberta' : 'fechada';
          extra += `<span class="next-fat">Próxima ${rot} (vence ${ddmm(faturaDatas(card, f).vence)}): <strong>${fmt(tot2)}</strong></span>`;
        }
      }
      return `
        <button class="tx" type="button" data-fat="${esc(id)}">
          <span class="card-ico" style="background:${cardColor(id)}"></span>
          <span class="tx-main"><span class="tx-desc">${esc(cardName(id))}</span>
            <span class="tx-sub"><span class="status ${st.cls}">${esc(st.txt)}</span></span>${extra}</span>
          <span class="tx-val neg">${fmt(total)}</span>
        </button>`;
    }).join('');
  }

  function renderCatBars(el, items, tipo, emptyMsg) {
    const by = new Map();
    let total = 0;
    items.filter((t) => t.tipo === tipo).forEach((t) => {
      const k = t.categoria || 'Sem categoria';
      by.set(k, (by.get(k) || 0) + t.valor);
      total += t.valor;
    });
    const rows = [...by].sort((a, b) => b[1] - a[1]);
    if (!rows.length) { el.innerHTML = `<p class="empty">${emptyMsg}</p>`; return; }
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

  function txRowHTML(t, opts = {}) {
    const rec = t.tipo === 'Receita';
    const parts = [];
    if (opts.showDate) parts.push(ddmm(t.data));
    parts.push(t.categoria);
    if (t.hora && !opts.showDate) parts.push(t.hora);
    if (t.parcelas > 1) parts.push(`${t.parcela}/${t.parcelas}`);
    const badge = t.fixa ? '<span class="badge">fixo</span>' : '';
    return `
      <button class="tx" type="button" data-tx="${esc(t.id)}">
        <i class="dot" style="background:${catColor(t.categoria)}"></i>
        <span class="tx-main"><span class="tx-desc">${esc(t.descricao || t.categoria)}${badge}</span><span class="tx-sub">${esc(parts.join(' · '))}</span></span>
        <span class="tx-val ${rec ? 'pos' : 'neg'}">${rec ? '+' : '−'} ${fmt(t.valor)}</span>
      </button>`;
  }

  // ----- Lista de lançamentos (pela data da compra; parcelado aparece uma vez) -----
  function lancEntries(ym) {
    const seen = new Set();
    const out = [];
    state.tx.forEach((t) => {
      if (t.data.slice(0, 7) !== ym) return;
      if (t.grupo) {
        if (seen.has(t.grupo)) return;
        seen.add(t.grupo);
        const g = state.tx.filter((x) => x.grupo === t.grupo).sort((a, b) => a.parcela - b.parcela);
        out.push({ ...g[0], total: round2(g.reduce((s, x) => s + x.valor, 0)), grupoN: g.length });
      } else out.push({ ...t, total: t.valor, grupoN: 0 });
    });
    return out.sort((a, b) => b.data.localeCompare(a.data) || (b.hora || '').localeCompare(a.hora || '') || (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  }
  function filtrar(list, f) {
    if (f === 'receitas') return list.filter((t) => t.tipo === 'Receita');
    if (f === 'despesas') return list.filter((t) => t.tipo === 'Despesa');
    if (f === 'cartao') return list.filter((t) => t.cartao);
    return list;
  }
  function lancRowHTML(e) {
    const rec = e.tipo === 'Receita';
    const ico = e.cartao
      ? `<span class="card-ico" style="background:${cardColor(e.cartao)}" title="Cartão ${esc(cardName(e.cartao))}"></span>`
      : `<i class="dot" style="background:${catColor(e.categoria)}"></i>`;
    const parts = [e.categoria];
    if (e.cartao) {
      if (e.grupoN > 1) parts.push(`${cardName(e.cartao)} · ${e.grupoN}x de ${fmt(e.valor)}`);
      else parts.push(cardName(e.cartao) + (e.fatura ? ` · fatura ${monthShort(e.fatura)}` : ''));
    }
    if (e.hora) parts.push(e.hora);
    const badge = e.fixa ? '<span class="badge">fixo</span>' : '';
    return `
      <button class="tx" type="button" data-tx="${esc(e.id)}">
        <span class="ico-slot">${ico}</span>
        <span class="tx-main"><span class="tx-desc">${esc(e.descricao || e.categoria)}${badge}</span><span class="tx-sub">${esc(parts.join(' · '))}</span></span>
        <span class="tx-val ${rec ? 'pos' : 'neg'}">${rec ? '+' : '−'} ${fmt(e.total)}</span>
      </button>`;
  }
  function dayListHTML(entries) {
    let html = '';
    let last = '';
    entries.forEach((e) => {
      if (e.data !== last) { last = e.data; html += `<div class="day">${dayLabel(e.data)}</div>`; }
      html += lancRowHTML(e);
    });
    return html;
  }

  function renderRecent() {
    const list = lancEntries(state.ym).slice(0, 5);
    $('#recent').innerHTML = list.length
      ? dayListHTML(list)
      : '<p class="empty">Nenhum lançamento neste mês.<br>Toque em <strong>+</strong> para adicionar.</p>';
  }

  function renderLanc() {
    $$('.chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === state.filter));
    const list = filtrar(lancEntries(state.ym), state.filter);
    const inc = list.filter((t) => t.tipo === 'Receita').reduce((s, t) => s + t.total, 0);
    const out = list.filter((t) => t.tipo === 'Despesa').reduce((s, t) => s + t.total, 0);
    const n = list.length;
    let head = `<span>${n} ${n === 1 ? 'lançamento' : 'lançamentos'}</span>`;
    if (inc) head += `<span>Entradas <strong class="pos">${fmt(inc)}</strong></span>`;
    if (out) head += `<span>Saídas <strong class="neg">${fmt(out)}</strong></span>`;
    if (state.filter === 'cartao' || (out && list.some((t) => t.cartao))) head += '<span>Compras no cartão pela data da compra</span>';
    $('#list-head').innerHTML = head;
    const empty = {
      todos: 'Nenhum lançamento neste mês.',
      receitas: 'Nenhuma receita neste mês.',
      despesas: 'Nenhuma despesa neste mês.',
      cartao: 'Nenhuma compra no cartão neste mês.',
    }[state.filter];
    $('#list').innerHTML = n ? dayListHTML(list) : `<p class="empty">${empty}</p>`;
  }

  // ----- Gráfico de evolução (6 meses, pelo regime de caixa) -----
  function renderEvo() {
    const months = Array.from({ length: 6 }, (_, i) => addMonths(state.ym, i - 5));
    const data = months.map((ym) => {
      let inc = 0;
      let out = 0;
      monthData(ym).items.forEach((t) => { if (t.tipo === 'Receita') inc += t.valor; else out += t.valor; });
      return { ym, inc, out };
    });
    const max = Math.max(1, ...data.map((d) => Math.max(d.inc, d.out)));
    const cols = data.map((d) => `
      <button class="evo-col${d.ym === state.ym ? ' sel' : ''}" type="button" data-ym="${d.ym}" title="${monthName(d.ym)}: receitas ${fmt(d.inc)}, despesas ${fmt(d.out)}">
        <span class="evo-bars">
          <span class="evo-bar in" style="height:${(d.inc / max) * 100}%"></span>
          <span class="evo-bar out" style="height:${(d.out / max) * 100}%"></span>
        </span>
        <span class="evo-lbl">${monthShort(d.ym).split('/')[0]}</span>
      </button>`).join('');
    const sel = data[5];
    $('#chart-evo').innerHTML = `<div class="evo">${cols}</div>
      <div class="legend">
        <span><i style="background:var(--pos)"></i>Receitas <strong>${fmt(sel.inc)}</strong></span>
        <span><i style="background:var(--neg)"></i>Despesas <strong>${fmt(sel.out)}</strong></span>
        <span>Saldo <strong>${fmt(sel.inc - sel.out)}</strong></span>
      </div>`;
  }

  function setTab(tab) {
    if (!['inicio', 'lanc', 'graf'].includes(tab)) tab = 'inicio';
    state.tab = tab;
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== tab; });
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ls.set('mf_tab', tab);
    window.scrollTo(0, 0);
  }

  // ================= Selects reutilizáveis =================
  function fillCatSelect(sel, tipo, selected) {
    const cats = state.cats.filter((c) => c.tipo === tipo);
    let opts = cats.map((c) => `<option${c.nome === selected ? ' selected' : ''}>${esc(c.nome)}</option>`).join('');
    if (selected && !cats.some((c) => c.nome === selected)) opts = `<option selected>${esc(selected)}</option>` + opts;
    if (!opts) opts = '<option value="">(nenhuma categoria; crie no menu)</option>';
    sel.innerHTML = opts;
  }
  function fillPagSelect(sel, selected) {
    let opts = '<option value="">Conta / dinheiro / Pix</option>';
    opts += state.cards.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>Cartão ${esc(c.nome)}</option>`).join('');
    if (selected && !cardById(selected)) opts += `<option value="${esc(selected)}" selected>Cartão excluído</option>`;
    sel.innerHTML = opts;
  }

  // ================= Formulário de lançamento =================
  // mode: 'new' | 'edit' | 'confirm' (confirmar um fixo)
  function openTx(mode, data) {
    if (!freshEnough()) return;
    const t = mode === 'edit' ? data : null;
    const f = mode === 'confirm' ? data : null;
    state.form = { mode, tx: t, fixa: f, ref: f ? `${f.id}|${state.ym}` : '' };

    const titles = { new: 'Novo lançamento', edit: 'Editar lançamento', confirm: 'Confirmar fixo' };
    $('#tx-title').textContent = titles[mode];
    const src = t || f;
    const tipo = src ? src.tipo : 'Despesa';
    $(tipo === 'Receita' ? '#tipo-rec' : '#tipo-desp').checked = true;
    $('#f-valor').value = src ? src.valor.toFixed(2).replace('.', ',') : '';
    $('#f-desc').value = src ? src.descricao : '';
    fillCatSelect($('#f-cat'), tipo, src ? src.categoria : null);
    fillPagSelect($('#f-pag'), src ? src.cartao : '');
    $('#f-parc').innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${i + 1}x${i === 0 ? ' (à vista)' : ''}</option>`).join('');
    if (t) { $('#f-data').value = t.data; $('#f-hora').value = t.hora || ''; }
    else if (f) { $('#f-data').value = dateInMonth(state.ym, f.dia); $('#f-hora').value = nowHM(); }
    else { $('#f-data').value = defaultDate(); $('#f-hora').value = nowHM(); }
    $('#f-fixa').checked = false;
    $('#f-var').checked = false;
    $('#btn-del').hidden = mode !== 'edit';
    setError($('#dlg-tx .dlg-error'), '');
    updateTxForm();
    $('#dlg-tx').showModal();
    if (mode === 'new') setTimeout(() => $('#f-valor').focus(), 50);
  }

  function defaultDate() {
    return state.ym === ymOfDate(new Date()) ? todayISO() : dateInMonth(state.ym, 1);
  }
  const formTipo = () => document.querySelector('input[name="tipo"]:checked').value;

  function updateTxForm() {
    const form = state.form;
    const tipo = formTipo();
    $('#row-pag').hidden = tipo !== 'Despesa';
    const cartao = tipo === 'Despesa' ? $('#f-pag').value : '';
    const card = cardById(cartao);
    const podeParcelar = !!card && form.mode === 'new';
    $('#row-parc').hidden = !podeParcelar;
    const n = podeParcelar ? Number($('#f-parc').value) : 1;
    $('#lbl-valor').textContent = n > 1 ? 'Valor total da compra (R$)' : 'Valor (R$)';
    $('#row-fixa').hidden = form.mode !== 'new' || n > 1;
    $('#row-var').hidden = $('#row-fixa').hidden || !$('#f-fixa').checked;

    const hints = [];
    const data = $('#f-data').value;
    if (card && isISO(data)) {
      let fat = faturaDe(card, data);
      if (form.mode === 'edit' && form.tx.parcela > 1) fat = addMonths(fat, form.tx.parcela - 1);
      hints.push(`Entra na fatura de ${monthName(fat).toLowerCase()}, que vence em ${ddmm(faturaDatas(card, fat).vence)}.`);
      const v = parseValor($('#f-valor').value);
      if (n > 1 && v > 0) hints.push(`${n}x de ${fmt(Math.floor((v / n) * 100) / 100)}, a última em ${monthName(addMonths(fat, n - 1)).toLowerCase()}.`);
    }
    if (form.mode === 'edit' && form.tx.parcelas > 1) hints.push(`Parcela ${form.tx.parcela} de ${form.tx.parcelas}. A alteração vale só para esta parcela.`);
    if (form.mode === 'confirm') hints.push(`Fixo de ${monthName(state.ym).toLowerCase()}. Ajuste o valor se veio diferente.`);
    $('#tx-hint').textContent = hints.join(' ');
    $('#tx-hint').hidden = !hints.length;
  }

  async function saveTx(e) {
    e.preventDefault();
    const form = state.form;
    const dlg = $('#dlg-tx');
    const errEl = dlg.querySelector('.dlg-error');
    const tipo = formTipo();
    const valor = round2(parseValor($('#f-valor').value));
    const categoria = $('#f-cat').value;
    const data = $('#f-data').value;
    const hora = normHora($('#f-hora').value);
    const descricao = $('#f-desc').value.trim() || categoria;
    const cartao = tipo === 'Despesa' ? $('#f-pag').value : '';
    const card = cardById(cartao);
    if (!(valor > 0)) return setError(errEl, 'Informe um valor maior que zero.');
    if (!categoria) return setError(errEl, 'Escolha uma categoria.');
    if (!isISO(data)) return setError(errEl, 'Informe a data.');

    if (form.mode === 'edit') {
      const old = form.tx;
      let fatura = '';
      if (card) {
        fatura = faturaDe(card, data);
        if (old.parcelas > 1 && old.parcela > 1) fatura = addMonths(fatura, old.parcela - 1);
      } else if (cartao) fatura = old.fatura; // cartão excluído: mantém a fatura
      const t = { ...old, tipo, valor, descricao, categoria, data, hora, cartao, fatura };
      return run(async () => {
        await DB.update('Lancamentos', txTo(t));
        state.tx = state.tx.map((x) => (x.id === t.id ? t : x));
      }, 'Lançamento atualizado', dlg);
    }

    const base = {
      tipo, descricao, categoria, data, hora, cartao,
      fatura: card ? faturaDe(card, data) : '',
      parcela: 0, parcelas: 0, grupo: '', fixa: form.ref || '',
      criadoEm: new Date().toISOString(),
    };
    const novos = [];
    let novaFixa = null;
    const n = card && form.mode === 'new' ? Number($('#f-parc').value) : 1;
    if (n > 1) {
      const grupo = uid();
      const cada = Math.floor((valor / n) * 100) / 100;
      for (let i = 0; i < n; i++) {
        novos.push({
          ...base, id: uid(), grupo, parcela: i + 1, parcelas: n,
          valor: i === n - 1 ? round2(valor - cada * (n - 1)) : cada,
          fatura: addMonths(base.fatura, i),
        });
      }
    } else {
      const t = { ...base, id: uid(), valor };
      if (form.mode === 'new' && $('#f-fixa').checked) {
        const variavel = $('#f-var').checked;
        novaFixa = {
          id: uid(), tipo, descricao, categoria, valor, dia: Number(data.slice(8, 10)), cartao,
          inicio: data.slice(0, 7), fim: '', variavel, geradoAte: variavel ? '' : data.slice(0, 7),
        };
        t.fixa = `${novaFixa.id}|${data.slice(0, 7)}`;
      }
      novos.push(t);
    }
    const msg = n > 1 ? `Compra lançada em ${n}x` : form.mode === 'confirm' ? 'Fixo confirmado' : novaFixa ? 'Lançamento fixo criado' : 'Lançamento salvo';
    await run(async () => {
      if (novaFixa) { await DB.add('Fixas', [fixaTo(novaFixa)]); state.fixas.push(novaFixa); }
      await DB.add('Lancamentos', novos.map(txTo));
      state.tx.push(...novos);
    }, msg, dlg);
  }

  async function deleteTx() {
    const t = state.form && state.form.tx;
    if (!t) return;
    const grupo = t.grupo ? state.tx.filter((x) => x.grupo === t.grupo) : [t];
    const msg = grupo.length > 1
      ? `Esta compra foi parcelada em ${t.parcelas}x. Todas as ${grupo.length} parcelas serão excluídas.`
      : 'Excluir este lançamento?';
    if (!(await askConfirm(msg))) return;
    const ids = new Set(grupo.map((x) => x.id));
    await run(async () => {
      await DB.remove('Lancamentos', [...ids]);
      state.tx = state.tx.filter((x) => !ids.has(x.id));
    }, grupo.length > 1 ? 'Parcelas excluídas' : 'Lançamento excluído', $('#dlg-tx'));
  }

  // ================= Fatura =================
  function openFatura(cardId) {
    state.fat = { cardId, ym: state.ym };
    renderFatura();
    $('#dlg-fatura').showModal();
  }
  function renderFatura() {
    if (!state.fat) return;
    const { cardId, ym } = state.fat;
    const card = cardById(cardId);
    const items = state.tx.filter((t) => t.cartao === cardId && t.fatura === ym)
      .sort((a, b) => b.data.localeCompare(a.data) || (b.hora || '').localeCompare(a.hora || ''));
    const total = items.reduce((s, t) => s + (t.tipo === 'Receita' ? -t.valor : t.valor), 0);
    $('#fat-title').textContent = `Fatura ${cardName(cardId)}`;
    $('#fat-sub').textContent = `${monthName(ym)}${card ? ' · ' + faturaStatus(card, ym).txt : ''}`;
    $('#fat-total').textContent = fmt(total);
    $('#fat-list').innerHTML = items.length
      ? items.map((t) => txRowHTML(t, { showDate: true })).join('')
      : '<p class="empty">Nenhuma compra nesta fatura.</p>';
  }

  // ================= Cartões =================
  function renderCardsList() {
    const el = $('#cards-list');
    if (!state.cards.length) { el.innerHTML = '<p class="empty">Nenhum cartão cadastrado.</p>'; return; }
    el.innerHTML = state.cards.map((c) => {
      const right = c.limite > 0
        ? `<span class="tx-right"><span class="tx-val">${fmt(c.limite - usedLimit(c))}</span><small>disponível</small></span>`
        : '';
      return `
        <button class="tx" type="button" data-card="${esc(c.id)}">
          <span class="card-ico" style="background:${c.cor}"></span>
          <span class="tx-main"><span class="tx-desc">${esc(c.nome)}</span><span class="tx-sub">Melhor dia ${c.fech} · vence dia ${c.venc}</span></span>
          ${right}
        </button>`;
    }).join('');
  }
  function openCards() { renderCardsList(); $('#dlg-cards').showModal(); }

  function openCard(card) {
    if (!freshEnough()) return;
    state.form = { mode: card ? 'edit' : 'new', card };
    $('#card-title').textContent = card ? 'Editar cartão' : 'Novo cartão';
    $('#k-nome').value = card ? card.nome : '';
    $('#k-fech').value = card ? card.fech : '';
    $('#k-venc').value = card ? card.venc : '';
    $('#k-lim').value = card && card.limite ? card.limite.toFixed(2).replace('.', ',') : '';
    $('#k-cor').value = card ? card.cor : '#7c3aed';
    $('#btn-card-del').hidden = !card;
    setError($('#dlg-card .dlg-error'), '');
    updateCardHint();
    $('#dlg-card').showModal();
    if (!card) setTimeout(() => $('#k-nome').focus(), 50);
  }
  function updateCardHint() {
    const h = cardHint(Number($('#k-fech').value), Number($('#k-venc').value));
    $('#card-hint').textContent = h;
    $('#card-hint').hidden = !h;
  }
  async function saveCard(e) {
    e.preventDefault();
    const dlg = $('#dlg-card');
    const errEl = dlg.querySelector('.dlg-error');
    const nome = $('#k-nome').value.trim();
    const fech = Number($('#k-fech').value);
    const venc = Number($('#k-venc').value);
    const limRaw = $('#k-lim').value.trim();
    const limite = limRaw ? round2(parseValor(limRaw)) : 0;
    if (!nome) return setError(errEl, 'Dê um nome ao cartão.');
    if (!(fech >= 1 && fech <= 31 && Number.isInteger(fech))) return setError(errEl, 'Melhor dia de compra deve ser de 1 a 31.');
    if (!(venc >= 1 && venc <= 31 && Number.isInteger(venc))) return setError(errEl, 'Dia de vencimento deve ser de 1 a 31.');
    if (limRaw && !(limite >= 0)) return setError(errEl, 'Limite inválido.');
    const old = state.form.card;
    const c = { ...(old || {}), id: old ? old.id : uid(), nome, fech, venc, limite, cor: $('#k-cor').value };
    await run(async () => {
      if (old) {
        await DB.update('Cartoes', cardTo(c));
        state.cards = state.cards.map((x) => (x.id === c.id ? c : x));
      } else {
        await DB.add('Cartoes', [cardTo(c)]);
        state.cards.push(c);
      }
    }, old ? 'Cartão atualizado' : 'Cartão cadastrado', dlg);
  }
  async function deleteCard() {
    const c = state.form.card;
    if (!c) return;
    const n = state.tx.filter((t) => t.cartao === c.id).length;
    const msg = `Excluir o cartão "${c.nome}"?` + (n ? ` As ${n} compras já lançadas continuam contando nas faturas.` : '');
    if (!(await askConfirm(msg))) return;
    await run(async () => {
      await DB.remove('Cartoes', [c.id]);
      state.cards = state.cards.filter((x) => x.id !== c.id);
    }, 'Cartão excluído', $('#dlg-card'));
  }

  // ================= Fixos =================
  function renderFixasList() {
    const el = $('#fixas-list');
    const cur = ymOfDate(new Date());
    const group = (tipo, titulo) => {
      const fs = state.fixas.filter((f) => f.tipo === tipo).sort((a, b) => a.dia - b.dia);
      if (!fs.length) return '';
      return `<div class="group-title">${titulo}</div>` + fs.map((f) => {
        const rec = tipo === 'Receita';
        const enc = f.fim && f.fim < cur;
        const periodo = `desde ${monthShort(f.inicio || cur)}${f.fim ? ' até ' + monthShort(f.fim) : ''}`;
        const sub = [`Dia ${f.dia}`, f.cartao ? cardName(f.cartao) : '', periodo].filter(Boolean).join(' · ');
        return `
          <button class="tx" type="button" data-fixa="${esc(f.id)}">
            <i class="dot" style="background:${catColor(f.categoria)}"></i>
            <span class="tx-main"><span class="tx-desc">${esc(f.descricao)}${f.variavel ? '<span class="badge">variável</span>' : ''}${enc ? '<span class="badge off">encerrado</span>' : ''}</span><span class="tx-sub">${esc(sub)}</span></span>
            <span class="tx-val ${rec ? 'pos' : 'neg'}">${rec ? '+' : '−'} ${fmt(f.valor)}</span>
          </button>`;
      }).join('');
    };
    const html = group('Despesa', 'Despesas fixas') + group('Receita', 'Receitas fixas');
    el.innerHTML = html || '<p class="empty">Nenhum lançamento fixo. Ex.: salário, aluguel, internet, assinaturas.</p>';
  }
  function openFixas() { renderFixasList(); $('#dlg-fixas').showModal(); }

  const fxTipo = () => document.querySelector('input[name="fx-tipo"]:checked').value;
  function openFixa(f) {
    if (!freshEnough()) return;
    state.form = { mode: f ? 'edit' : 'new', fixa: f };
    $('#fixa-title').textContent = f ? 'Editar lançamento fixo' : 'Novo lançamento fixo';
    const tipo = f ? f.tipo : 'Despesa';
    $(tipo === 'Receita' ? '#fx-rec' : '#fx-desp').checked = true;
    $('#x-desc').value = f ? f.descricao : '';
    $('#x-valor').value = f ? f.valor.toFixed(2).replace('.', ',') : '';
    $('#x-dia').value = f ? f.dia : '';
    fillCatSelect($('#x-cat'), tipo, f ? f.categoria : null);
    fillPagSelect($('#x-pag'), f ? f.cartao : '');
    $('#x-ini').value = f ? f.inicio : state.ym;
    $('#x-fim').value = f ? f.fim : '';
    $('#row-x-pag').hidden = tipo !== 'Despesa';
    $('#x-var').checked = f ? f.variavel : false;
    updateVarHint();
    $('#btn-fixa-del').hidden = !f;
    setError($('#dlg-fixa .dlg-error'), '');
    $('#dlg-fixa').showModal();
    if (!f) setTimeout(() => $('#x-desc').focus(), 50);
  }
  function updateVarHint() {
    $('#x-var-hint').textContent = $('#x-var').checked
      ? 'Aparece todo mês em "Fixos a confirmar" para você informar o valor certo.'
      : 'Lançado automaticamente todo mês, no dia escolhido, com este valor.';
  }

  async function saveFixa(e) {
    e.preventDefault();
    const dlg = $('#dlg-fixa');
    const errEl = dlg.querySelector('.dlg-error');
    const tipo = fxTipo();
    const descricao = $('#x-desc').value.trim();
    const valor = round2(parseValor($('#x-valor').value));
    const dia = Number($('#x-dia').value);
    const categoria = $('#x-cat').value;
    const cartao = tipo === 'Despesa' ? $('#x-pag').value : '';
    const inicio = normYM($('#x-ini').value);
    const fim = normYM($('#x-fim').value);
    if (!descricao) return setError(errEl, 'Informe a descrição.');
    if (!(valor > 0)) return setError(errEl, 'Informe um valor maior que zero.');
    if (!(dia >= 1 && dia <= 31 && Number.isInteger(dia))) return setError(errEl, 'Dia do mês deve ser de 1 a 31.');
    if (!categoria) return setError(errEl, 'Escolha uma categoria.');
    if (!isYM(inicio)) return setError(errEl, 'Informe o mês de início (aaaa-mm).');
    if ($('#x-fim').value && !isYM(fim)) return setError(errEl, 'Mês final inválido (aaaa-mm).');
    if (fim && fim < inicio) return setError(errEl, 'O mês final deve ser depois do início.');
    const old = state.form.fixa;
    const variavel = $('#x-var').checked;
    const f = { ...(old || {}), id: old ? old.id : uid(), tipo, descricao, valor, dia, categoria, cartao, inicio, fim, variavel };
    // Fixo de valor igual começa a ser lançado a partir do mês atual (não cria meses passados)
    if (!variavel && (!old || old.variavel)) {
      const cur = ymOfDate(new Date());
      f.geradoAte = addMonths(inicio > cur ? inicio : cur, -1);
    }
    await run(async () => {
      if (old) {
        await DB.update('Fixas', fixaTo(f));
        state.fixas = state.fixas.map((x) => (x.id === f.id ? f : x));
      } else {
        await DB.add('Fixas', [fixaTo(f)]);
        state.fixas.push(f);
      }
      await autoLancarFixos();
    }, old ? 'Fixo atualizado' : 'Fixo criado', dlg);
  }
  async function deleteFixa() {
    const f = state.form.fixa;
    if (!f) return;
    if (!(await askConfirm(`Excluir o fixo "${f.descricao}"? Os lançamentos já confirmados continuam. Se só parou de pagar, prefira preencher "Termina em".`))) return;
    await run(async () => {
      await DB.remove('Fixas', [f.id]);
      state.fixas = state.fixas.filter((x) => x.id !== f.id);
    }, 'Fixo excluído', $('#dlg-fixa'));
  }

  // ================= Categorias =================
  function renderCats() {
    const group = (tipo, titulo) => {
      const cs = state.cats.filter((c) => c.tipo === tipo);
      return `<div class="group-title">${titulo}</div>` + (cs.length
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
    const ok = await run(async () => {
      await DB.add('Categorias', [{ Nome: c.nome, Tipo: c.tipo, Cor: c.cor }]);
      state.cats.push(c);
    }, 'Categoria adicionada');
    if (ok) $('#c-nome').value = '';
  }
  async function onDelCat(e) {
    const b = e.target.closest('[data-del-cat]');
    if (!b) return;
    const nome = b.dataset.delCat;
    if (!(await askConfirm(`Excluir a categoria "${nome}"? Os lançamentos já feitos continuam com esse nome.`))) return;
    await run(async () => {
      await DB.remove('Categorias', [nome]);
      state.cats = state.cats.filter((c) => c.nome !== nome);
    }, 'Categoria excluída');
  }

  function refreshDialogs() {
    if ($('#dlg-fatura').open) renderFatura();
    if ($('#dlg-cards').open) renderCardsList();
    if ($('#dlg-fixas').open) renderFixasList();
    if ($('#dlg-cats').open) renderCats();
  }

  // ================= Dados =================
  async function loadData() {
    const [tx, cats, cards, fixas] = await Promise.all(TABLES.map((t) => DB.list(t)));
    state.cats = cats.map(catFrom).filter((c) => c.nome);
    state.cards = cards.map(cardFrom);
    state.fixas = fixas.map(fixaFrom);
    state.tx = tx.map(txFrom).filter((t) => t.data);
    // Compras digitadas direto na planilha sem a coluna Fatura: calcula
    state.tx.forEach((t) => {
      if (t.cartao && !t.fatura) { const c = cardById(t.cartao); if (c) t.fatura = faturaDe(c, t.data); }
    });
    try {
      const n = await autoLancarFixos();
      if (n && !DEMO) setTimeout(() => toast(n === 1 ? '1 lançamento fixo lançado automaticamente' : `${n} lançamentos fixos lançados automaticamente`), 400);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      console.error(err);
    }
    render();
    refreshDialogs();
  }

  // ================= Eventos =================
  function openByName(name) {
    $('#dlg-menu').open && $('#dlg-menu').close();
    if (name === 'cards') openCards();
    else if (name === 'card-new') openCard(null);
    else if (name === 'fixas') openFixas();
    else if (name === 'fixa-new') openFixa(null);
    else if (name === 'cats') { if (!freshEnough()) return; renderCats(); $('#dlg-cats').showModal(); }
  }

  function bindUI() {
    $('#btn-login').addEventListener('click', () => Auth.redirect(false));
    $('#btn-prev').addEventListener('click', () => { state.ym = addMonths(state.ym, -1); render(); });
    $('#btn-next').addEventListener('click', () => { state.ym = addMonths(state.ym, 1); render(); });
    $('#month-label').addEventListener('click', () => { state.ym = ymOfDate(new Date()); render(); });
    $('#btn-add').addEventListener('click', () => openTx('new'));

    // Cliques em listas (delegação)
    document.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) return openByName(open.dataset.open);
      const tab = e.target.closest('[data-tab]');
      if (tab) return setTab(tab.dataset.tab);
      const chip = e.target.closest('[data-filter]');
      if (chip) { state.filter = chip.dataset.filter; renderLanc(); return; }
      const col = e.target.closest('[data-ym]');
      if (col) { state.ym = col.dataset.ym; render(); return; }
      const tx = e.target.closest('[data-tx]');
      if (tx) { const t = state.tx.find((x) => x.id === tx.dataset.tx); if (t) openTx('edit', t); return; }
      const fat = e.target.closest('[data-fat]');
      if (fat) return openFatura(fat.dataset.fat);
      const prev = e.target.closest('[data-prev]');
      if (prev) { const f = state.fixas.find((x) => x.id === prev.dataset.prev); if (f) openTx('confirm', f); return; }
      const card = e.target.closest('[data-card]');
      if (card) return openCard(cardById(card.dataset.card));
      const fixa = e.target.closest('[data-fixa]');
      if (fixa) { const f = state.fixas.find((x) => x.id === fixa.dataset.fixa); if (f) openFixa(f); }
    });
    $('#prev-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-prev]')) e.target.click(); });

    // Formulário de lançamento
    $$('input[name="tipo"]').forEach((r) => r.addEventListener('change', () => {
      fillCatSelect($('#f-cat'), r.value, null);
      updateTxForm();
    }));
    ['#f-pag', '#f-parc', '#f-data', '#f-valor'].forEach((s) => $(s).addEventListener('input', updateTxForm));
    $('#f-pag').addEventListener('change', updateTxForm);
    $('#f-fixa').addEventListener('change', updateTxForm);
    $('#x-var').addEventListener('change', updateVarHint);
    $('#form-tx').addEventListener('submit', saveTx);
    $('#btn-del').addEventListener('click', deleteTx);

    // Cartão
    ['#k-fech', '#k-venc'].forEach((s) => $(s).addEventListener('input', updateCardHint));
    $('#form-card').addEventListener('submit', saveCard);
    $('#btn-card-del').addEventListener('click', deleteCard);

    // Fixo
    $$('input[name="fx-tipo"]').forEach((r) => r.addEventListener('change', () => {
      fillCatSelect($('#x-cat'), r.value, null);
      $('#row-x-pag').hidden = r.value !== 'Despesa';
    }));
    $('#form-fixa').addEventListener('submit', saveFixa);
    $('#btn-fixa-del').addEventListener('click', deleteFixa);

    // Menu e categorias
    $('#btn-menu').addEventListener('click', () => $('#dlg-menu').showModal());
    $('#menu-sheet').addEventListener('click', () => $('#dlg-menu').close());
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

    $$('dialog').forEach((d) => {
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
    } catch (err) {
      if (err instanceof AuthError) return onAuthLost();
      console.error(err);
      showLogin('Erro ao carregar: ' + err.message);
    }
  }

  function boot() {
    bindUI();
    setTab(ls.get('mf_tab') || 'inicio');
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

  // ================= Dados de demonstração =================
  function seedDemo() {
    const now = new Date();
    const cur = ymOfDate(now);
    const hoje = now.getDate();
    const c1 = { id: 'c1', nome: 'Principal', fech: 5, venc: 10, limite: 6000, cor: '#7c3aed' };
    const c2 = { id: 'c2', nome: 'Mercado', fech: 28, venc: 5, limite: 2500, cor: '#0891b2' };
    const cards = { c1, c2 };
    const fx = [
      { id: 'f1', tipo: 'Receita', descricao: 'Salário', categoria: 'Salário', valor: 5200, dia: 5, cartao: '' },
      { id: 'f2', tipo: 'Despesa', descricao: 'Prestação do apartamento', categoria: 'Moradia', valor: 1350, dia: 1, cartao: '' },
      { id: 'f3', tipo: 'Despesa', descricao: 'Internet', categoria: 'Contas', valor: 99.9, dia: 15, cartao: '' },
      { id: 'f4', tipo: 'Despesa', descricao: 'Conta de luz', categoria: 'Contas', valor: 160, dia: 20, cartao: '', variavel: true },
      { id: 'f6', tipo: 'Despesa', descricao: 'Conta de água', categoria: 'Contas', valor: 85, dia: 25, cartao: '', variavel: true },
      { id: 'f5', tipo: 'Despesa', descricao: 'Streaming', categoria: 'Lazer', valor: 39.9, dia: 12, cartao: 'c1' },
    ].map((f) => ({ variavel: false, ...f, inicio: addMonths(cur, -6), fim: '', geradoAte: f.variavel ? '' : addMonths(cur, -1) }));

    const tx = [];
    const add = (o) => {
      const card = o.cartao ? cards[o.cartao] : null;
      tx.push({
        id: uid(), hora: '', cartao: '', parcela: 0, parcelas: 0, grupo: '', fixa: '', criadoEm: '', ...o,
        fatura: card ? faturaDe(card, o.data) : '',
      });
    };
    const d = (ym, day) => dateInMonth(ym, ym === cur ? Math.min(day, hoje) : day);

    // Fixos dos meses anteriores (os do mês atual são lançados pela regra automática;
    // luz e água, por serem variáveis, ficam em "Fixos a confirmar")
    [-5, -4, -3, -2, -1].forEach((k) => {
      const ym = addMonths(cur, k);
      add({ data: dateInMonth(ym, 14), hora: '18:00', tipo: 'Despesa', descricao: 'Supermercado', categoria: 'Alimentação', valor: round2(450 + Math.random() * 250) });
      add({ data: dateInMonth(ym, 21), hora: '08:30', tipo: 'Despesa', descricao: 'Combustível', categoria: 'Transporte', valor: round2(150 + Math.random() * 80) });
      fx.forEach((f) => {
        const valor = f.variavel ? round2(f.valor * (0.85 + Math.random() * 0.3)) : f.valor;
        add({ data: dateInMonth(ym, f.dia), hora: '09:00', tipo: f.tipo, descricao: f.descricao, categoria: f.categoria, valor, cartao: f.cartao, fixa: `${f.id}|${ym}` });
      });
    });

    // Avulsos
    const prev = addMonths(cur, -1);
    add({ data: d(cur, 3), hora: '18:42', tipo: 'Despesa', descricao: 'Supermercado', categoria: 'Alimentação', valor: 412.35, cartao: 'c2' });
    add({ data: d(cur, 8), hora: '07:15', tipo: 'Despesa', descricao: 'Gasolina', categoria: 'Transporte', valor: 180 });
    add({ data: d(cur, 12), hora: '20:03', tipo: 'Despesa', descricao: 'Farmácia', categoria: 'Saúde', valor: 89.5 });
    add({ data: d(cur, 15), hora: '21:30', tipo: 'Despesa', descricao: 'Cinema', categoria: 'Lazer', valor: 70, cartao: 'c1' });
    add({ data: d(cur, 18), hora: '08:10', tipo: 'Despesa', descricao: 'Padaria', categoria: 'Alimentação', valor: 38.2 });
    add({ data: d(cur, 22), hora: '12:40', tipo: 'Despesa', descricao: 'Restaurante', categoria: 'Alimentação', valor: 96, cartao: 'c1' });
    add({ data: d(cur, 20), hora: '10:00', tipo: 'Receita', descricao: 'Rendimento poupança', categoria: 'Rendimentos', valor: 42.15 });
    add({ data: dateInMonth(prev, 2), hora: '17:20', tipo: 'Despesa', descricao: 'Supermercado', categoria: 'Alimentação', valor: 540, cartao: 'c2' });
    add({ data: dateInMonth(prev, 9), hora: '19:05', tipo: 'Despesa', descricao: 'Tênis', categoria: 'Compras', valor: 349.9, cartao: 'c1' });
    add({ data: dateInMonth(prev, 25), hora: '14:00', tipo: 'Despesa', descricao: 'Pizza', categoria: 'Alimentação', valor: 78, cartao: 'c1' });

    // Compra parcelada: geladeira em 10x, comprada há 2 meses
    const gData = dateInMonth(addMonths(cur, -2), 20);
    const g0 = faturaDe(c1, gData);
    const grupo = uid();
    for (let i = 0; i < 10; i++) {
      tx.push({
        id: uid(), data: gData, hora: '15:30', tipo: 'Despesa', descricao: 'Geladeira', categoria: 'Compras',
        valor: 349.9, cartao: 'c1', fatura: addMonths(g0, i), parcela: i + 1, parcelas: 10, grupo, fixa: '', criadoEm: '',
      });
    }

    return {
      Lancamentos: tx.map(txTo),
      Categorias: DEFAULT_CATS.map((c) => ({ ...c })),
      Cartoes: [c1, c2].map(cardTo),
      Fixas: fx.map(fixaTo),
    };
  }

  boot();
})();
