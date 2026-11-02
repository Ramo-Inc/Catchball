// session-mail WebUI（閲覧専用）。本文は textContent でだけ表示し、HTML として扱わない。
// window.__SM_SNAPSHOT__ があれば、その記録を表示する（公開用の読み取り専用ページ）
(() => {
  'use strict';
  const SNAP = window.__SM_SNAPSHOT__ || null;
  const app = document.getElementById('app');
  const S = {
    rooms: [], room: null, roomGone: null,
    members: [], messages: new Map(), order: [], maxSeq: 0, hasOlder: false, oldestSeq: null,
    filter: { kind: 'all', participant: '', q: '' }, selected: null, expanded: new Set(), openDeliv: new Set(),
    lastOk: null, failures: 0, newCount: 0,
    gen: 0,  // 表示の世代。ルームや絞り込みを変えるたびに増やし、古い条件で出した要求の応答は捨てる
  };

  // ---- 小道具 ----
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const pad = n => String(n).padStart(2, '0');
  const fmtTime = t => {
    const d = new Date(t), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return d.toDateString() === now.toDateString() ? hm : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
  };
  const nameOf = id => S.members.find(m => m.id === id)?.display_name || id;

  // 参加者ごとの番号アイコン（参加者欄の並び順で 1, 2, 3 …）
  const memberNo = id => { const i = S.members.findIndex(m => m.id === id); return i < 0 ? '?' : String(i + 1); };
  const providerOf = id => S.members.find(m => m.id === id)?.provider || '';
  const avatar = (id, extraClass = '') => el('span', { class: `av ${providerOf(id)} ${extraClass}`, 'aria-hidden': 'true' }, memberNo(id));
  const STATUS_MARK = { acked: ['✓', '取得済み'], pending: ['…', '未取得'], attention: ['!', '要確認'], cancelled_left: ['×', '退出で配送停止'] };
  function recipientIcon(d) {
    const [mark, label] = STATUS_MARK[d.ui_state] || STATUS_MARK.pending;
    const text = `${d.recipient_display_name}：${d.detail}`;
    return el('span', { class: `rcpt st-${d.ui_state}`, title: text, role: 'img', 'aria-label': text },
      avatar(d.recipient_id), el('span', { class: 'mark', 'aria-hidden': 'true' }, mark),
      el('span', { class: 'sr' }, label));
  }

  // ---- データ取得（スナップショットなら埋め込みデータから） ----
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts,
      headers: opts.body ? { 'content-type': 'application/json' } : undefined });
    if (res.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data;
  }
  // ---- ルーム（D-018）。選んだルームはこのブラウザーに覚えておく ----
  const ROOM_KEY = 'session-mail.room';
  const saved = () => { try { return localStorage.getItem(ROOM_KEY); } catch { return null; } };
  const save = r => { try { if (r) localStorage.setItem(ROOM_KEY, r); } catch { /* 保存できなくても動く */ } };
  async function loadRooms() {
    // 記録（export）にはルームの一覧がある。古い記録は1つのチャンネルだけ
    S.rooms = SNAP ? (SNAP.rooms || [{ room: SNAP.channel_id || 'dev' }]) : (await api('/api/ui/rooms')).rooms;
    const names = S.rooms.map(r => r.room);
    if (S.room && !names.includes(S.room)) { S.roomGone = S.room; S.room = null; }
    if (!S.room) {
      const want = saved();
      S.room = names.includes(want) ? want : names[0] || null;
      S.filter.participant = ''; S.selected = null;
    }
  }
  function selectRoom(r) {
    S.room = r; S.roomGone = null; save(r);
    S.filter.participant = ''; S.selected = null;
    loadMembers().then(reload).catch(() => {});
  }

  function snapQuery(params) {
    let list = SNAP.messages.filter(m => !m.room || m.room === S.room);
    const f = S.filter;
    if (f.kind !== 'all') list = list.filter(m => m.kind === f.kind);
    if (f.participant) list = list.filter(m => m.sender.id === f.participant || m.deliveries.some(d => d.recipient_id === f.participant));
    if (f.q) list = list.filter(m => m.body.includes(f.q));
    if (params.since_seq != null) return { messages: [], max_seq: SNAP.max_seq, has_older: false };
    return { messages: list, max_seq: SNAP.max_seq, has_older: false, oldest_seq: null };
  }
  function query(extra) {
    const p = new URLSearchParams();
    if (S.filter.kind !== 'all') p.set('kind', S.filter.kind);
    if (S.filter.participant) p.set('participant', S.filter.participant);
    if (S.filter.q) p.set('q', S.filter.q);
    for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
    if (!S.room) return Promise.resolve({ messages: [], max_seq: S.maxSeq, has_older: false, oldest_seq: null });
    p.set('room', S.room);
    return SNAP ? Promise.resolve(snapQuery(extra)) : api('/api/messages?' + p);
  }
  const loadMembers = async () => {
    if (!S.room) { S.members = []; return; }
    S.members = SNAP ? (SNAP.participants ? SNAP.participants.filter(m => m.room === S.room) : SNAP.members)
      : (await api('/api/members?room=' + encodeURIComponent(S.room))).members;
  };

  function merge(list, mode) {
    for (const m of list) {
      const isNew = !S.messages.has(m.message_id);
      S.messages.set(m.message_id, m);
      if (isNew) {
        if (mode === 'older') S.order.unshift(m.message_id);
        else { S.order.push(m.message_id); if (mode === 'poll') S.newCount += 1; }
      }
    }
    S.order.sort((a, b) => S.messages.get(a).created_seq - S.messages.get(b).created_seq);
  }

  async function reload() {
    const gen = ++S.gen;
    S.messages.clear(); S.order = []; S.newCount = 0;
    const r = await query({ limit: 100 });
    if (gen !== S.gen) return;
    merge(r.messages, 'init');
    S.maxSeq = r.max_seq; S.hasOlder = r.has_older; S.oldestSeq = r.oldest_seq;
    S.lastOk = Date.now();
    renderAll();
    window.scrollTo(0, document.body.scrollHeight);
  }

  async function loadOlder() {
    const gen = S.gen;
    const r = await query({ before_seq: S.oldestSeq, limit: 100 });
    if (gen !== S.gen) return;
    merge(r.messages, 'older');
    S.hasOlder = r.has_older; S.oldestSeq = r.oldest_seq ?? S.oldestSeq;
    renderAll();
  }

  async function poll() {
    const gen = S.gen;
    try {
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
      const before = S.room;
      await loadRooms();
      if (gen !== S.gen) return;
      if (S.room !== before) { await loadMembers(); renderFilters(); return reload(); }
      await loadMembers();
      const r = await query({ since_seq: S.maxSeq, limit: 200 });
      if (gen !== S.gen) return;  // 待っている間に、ルームや絞り込みが変わった
      merge(r.messages, 'poll');
      S.maxSeq = r.max_seq; S.lastOk = Date.now(); S.failures = 0;
      renderAll(true);
      if (atBottom && S.newCount) { S.newCount = 0; renderNewBtn(); window.scrollTo(0, document.body.scrollHeight); }
    } catch (e) {
      if (gen !== S.gen) return;
      if (e.status === 401) return showLogin();
      S.failures += 1;
      renderTop();
    }
  }

  // ---- 描画 ----
  let refs = {};
  function shell() {
    app.replaceChildren();
    refs.top = el('div', { class: 'topbar' });
    // 見出し・ルームの選択・接続の状態は別々の入れ物にし、定期更新では選択欄を作り直さない（操作が途切れないように）
    refs.title = el('h1', {});
    refs.roomBox = el('span', {});
    refs.status = el('span', { class: 'conn' });
    refs.roomSig = null;
    refs.top.append(refs.title, el('div', { class: 'conn' }, refs.roomBox, refs.status));
    refs.banner = el('div', { class: 'banner', hidden: true });
    refs.side = el('aside', { class: 'side', 'aria-label': '参加者' });
    refs.filters = el('div', { class: 'filters' });
    refs.list = el('div', { class: 'main', 'aria-label': '通信履歴' });
    refs.newBtn = el('button', { class: 'newbtn', type: 'button', hidden: true, onclick: () => { S.newCount = 0; renderNewBtn(); window.scrollTo({ top: document.body.scrollHeight }); } });
    app.append(el('div', { class: 'wrap' },
      refs.top, refs.banner,
      el('div', { class: 'grid' }, refs.side, el('section', { class: 'main' }, refs.filters, refs.list)),
      el('footer', {}, 'この画面は通信の観察用です。AI 同士の個別通信もすべて表示されます（参加 AI 間の秘密のやり取りではありません）。本文はテキストとしてだけ表示し、リンクやスクリプトは動かしません。'),
    ), refs.newBtn);
    renderFilters();
  }

  function renderTop() {
    const live = SNAP ? null : S.failures >= 2 ? el('span', { class: 'dead' }, '● 切断中') : el('span', { class: 'live' }, '● 接続中');
    const upd = S.lastOk ? (SNAP ? `記録時点 ${new Date(SNAP.exported_at).toLocaleString('ja-JP', { hour12: false })}` : `更新 ${fmtTime(S.lastOk)}`) : '';
    const sig = JSON.stringify([S.rooms.map(r => r.room), S.room]);
    if (sig !== refs.roomSig && !refs.roomBox.contains(document.activeElement)) {
      refs.roomSig = sig;
      refs.roomBox.replaceChildren(...(S.rooms.length ? [el('select', { id: 'room', 'aria-label': 'ルームを選ぶ', onchange: e => selectRoom(e.target.value) },
        ...S.rooms.map(r => el('option', { value: r.room, selected: r.room === S.room }, `ルーム ${r.room}`)))] : []));
    }
    refs.title.replaceChildren('AI通信', el('small', {}, S.room ? `/ ルーム ${S.room}${SNAP ? '（記録の表示）' : ''}` : '/ ルームがありません'));
    refs.status.replaceChildren(...[live, upd, SNAP ? null : el('button', { class: 'linkbtn', type: 'button', onclick: logout }, 'ログアウト')].filter(x => x != null && x !== ''));
    const dead = S.failures >= 2;
    refs.banner.hidden = !dead && !S.roomGone;
    refs.banner.textContent = dead ? `接続が切れています。表示は最終取得時点のものです（最終更新 ${S.lastOk ? fmtTime(S.lastOk) : 'なし'}）。`
      : S.roomGone ? `ルーム ${S.roomGone} は削除されました。${S.room ? `ルーム ${S.room} を表示しています。` : ''}` : '';
  }

  function memberCard(m) {
    const online = m.connection === 'online';
    const ar = { verified: '自動受信 確認済み', unverified: '自動受信 未確認', failing: '自動受信 失敗（要確認）', not_configured: '自動受信は未準備' }[m.auto_receive];
    const memb = { provisioned: '－ 未参加', left: '× 退出済み' }[m.membership];
    const selected = S.selected === m.id;
    return el('button', {
      class: 'member', type: 'button', 'aria-pressed': String(selected),
      onclick: () => { S.selected = selected ? null : m.id; S.filter.participant = S.selected || ''; renderFilters(); reload(); },
    },
      el('div', { class: 'm-top' }, avatar(m.id), el('span', { class: 'm-name' }, m.display_name || m.id), el('span', { class: 'prov ' + m.provider }, m.provider === 'codex' ? 'Codex' : 'Claude')),
      el('div', { class: 'm-role' }, m.role || '（役割は未登録）'),
      el('div', { class: 'm-state' },
        memb ? el('span', { class: 'st-off' }, memb) : el('span', { class: online ? 'st-on' : 'st-off' }, online ? '● 接続中' : '○ 切断中'),
        m.membership === 'joined' ? el('span', {}, ar) : null,
        m.pending_count ? el('span', {}, `未取得 ${m.pending_count}`) : null),
      m.reason && m.membership === 'joined' && !(m.auto_receive === 'unverified' && m.connection === 'online' && m.activity === 'unknown') ? el('div', { class: 'm-reason' }, m.reason) : null,
      selected ? el('div', { class: 'm-id' }, `固定ID: ${m.id}`) : null,
    );
  }

  function renderSide() {
    const joined = S.members.filter(m => m.membership === 'joined').length;
    refs.side.replaceChildren(el('p', { class: 'label' }, `参加者 ${joined}`),
      ...(S.members.length ? S.members.map(memberCard) : [el('div', { class: 'empty' }, '参加者はまだいません。導入手順（OPERATIONS.md）に沿って各セッションを接続してください。')]));
  }

  // 絞り込み欄は、操作したときに作り直す。定期更新では、参加者が変わり、しかも欄を操作していないときだけ作り直す
  let filterSig = null;
  function renderFilters(fromPoll = false) {
    const sig = JSON.stringify([S.members.map(m => [m.id, m.display_name, m.role]), S.filter]);
    if (fromPoll && (sig === filterSig || refs.filters.contains(document.activeElement))) return;
    filterSig = sig;
    const tab = (k, label) => el('button', { type: 'button', 'aria-pressed': String(S.filter.kind === k), onclick: () => { S.filter.kind = k; renderFilters(); reload(); } }, label);
    const sel = el('select', { id: 'f-participant', 'aria-label': '参加者で絞り込む', onchange: e => { S.filter.participant = e.target.value; S.selected = e.target.value || null; reload(); } },
      el('option', { value: '' }, '参加者: 全員'),
      ...S.members.map(m => el('option', { value: m.id, selected: S.filter.participant === m.id }, `${m.display_name || m.id} — ${(m.role || '').slice(0, 24)}`)));
    let timer;
    const q = el('input', { id: 'f-q', type: 'search', placeholder: '本文を検索', value: S.filter.q, 'aria-label': '本文を検索',
      oninput: e => { clearTimeout(timer); timer = setTimeout(() => { S.filter.q = e.target.value.trim(); reload(); }, 300); } });
    const legend = el('div', { class: 'legend', 'aria-label': '取得状況の記号' },
      ...Object.entries(STATUS_MARK).map(([k, [mark, label]]) => el('span', { class: `lg st-${k}` }, el('span', { class: 'mark', 'aria-hidden': 'true' }, mark), label)));
    // 作り直しても、操作していた欄のフォーカスとカーソルの位置は戻す（検索の入力中に途切れないように）
    const act = refs.filters.contains(document.activeElement) ? document.activeElement : null;
    const keep = act && { id: act.id, start: act.selectionStart, end: act.selectionEnd };
    refs.filters.replaceChildren(el('div', { class: 'tabs', role: 'group', 'aria-label': '種別' }, tab('all', 'すべて'), tab('direct', '個別'), tab('broadcast', '全員向け')), sel, q, legend);
    if (keep && keep.id) {
      const n = document.getElementById(keep.id);
      if (n) { n.focus(); if (keep.start != null && n.setSelectionRange) n.setSelectionRange(keep.start, keep.end); }
    }
  }

  function jumpTo(id) {
    const node = document.querySelector(`[data-mid="${id}"]`);
    const go = n => { n.scrollIntoView({ block: 'center' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1800); };
    if (node) return go(node);
    if (SNAP) return;
    api('/api/messages/' + id).then(m => { merge([m], 'older'); renderList(); const n = document.querySelector(`[data-mid="${id}"]`); if (n) go(n); })
      .catch(() => { /* 見つからない（ルームごと削除された など）ときは何もしない */ });
  }

  function msgCard(m) {
    const to = m.kind === 'broadcast' ? '全員' : (m.to_display_name || nameOf(m.to));
    const src = m.reply_to ? S.messages.get(m.reply_to) : null;
    const long = m.body.split('\n').length > 8 || m.body.length > 600;
    const open = S.expanded.has(m.message_id);
    const s = m.summary;
    const sumClass = s.attention ? 'attn' : s.acked === s.total ? 'all' : 'part';
    const delivOpen = S.openDeliv.has(m.message_id);
    return el('article', { class: 'msg', 'data-mid': m.message_id },
      el('div', { class: 'meta' },
        el('time', { title: new Date(m.created_at).toLocaleString('ja-JP') }, fmtTime(m.created_at)),
        el('span', { class: 'route' }, avatar(m.sender.id, 'small'), m.sender.display_name, el('span', { class: 'arrow' }, '→'), to),
        el('span', { class: 'kind ' + m.kind }, m.kind === 'broadcast' ? '全員向け' : '個別'),
        el('span', { class: 'mid' }, m.message_id)),
      m.reply_to ? el('button', { class: 'reply', type: 'button', onclick: () => jumpTo(m.reply_to) },
        src ? `↩ ${src.sender.display_name} の「${src.body.replace(/\s+/g, ' ').slice(0, 30)}…」への返信` : `↩ ${m.reply_to} への返信`) : null,
      el('p', { class: 'body' + (long && !open ? ' clamp' : '') }, m.body),
      long ? el('button', { class: 'linkbtn', type: 'button', onclick: () => { open ? S.expanded.delete(m.message_id) : S.expanded.add(m.message_id); renderList(); } }, open ? '折り畳む' : '全文を表示') : null,
      el('div', { class: 'foot' },
        el('span', { class: 'rcpts', 'aria-label': '宛先ごとの取得状況' }, ...m.deliveries.map(recipientIcon)),
        el('span', { class: 'sum ' + sumClass }, `取得済み ${s.acked}/${s.total}`
          + (s.cancelled ? ` ・退出 ${s.cancelled}` : '') + (s.attention ? ` ・要確認 ${s.attention}` : '')),
        s.note ? el('span', { class: 'note' }, s.note) : null,
        el('button', { class: 'linkbtn', type: 'button', onclick: () => { delivOpen ? S.openDeliv.delete(m.message_id) : S.openDeliv.add(m.message_id); renderList(); } },
          delivOpen ? '宛先ごとの状況を閉じる' : '宛先ごとの状況')),
      delivOpen ? el('ul', { class: 'deliv' }, ...m.deliveries.map(d => el('li', {},
        recipientIcon(d), el('span', { class: 'who' }, d.recipient_display_name), el('span', { class: 'd-' + d.ui_state }, d.detail)))) : null,
    );
  }

  function renderList() {
    const items = S.order.map(id => S.messages.get(id));
    const kids = [];
    if (S.hasOlder) kids.push(el('button', { class: 'linkbtn older', type: 'button', onclick: loadOlder }, '以前の通信を表示'));
    if (!S.room) kids.push(el('div', { class: 'empty' }, 'ルームがありません。AI にルームの作成を頼んでください（channel_room_create）。'));
    else if (!items.length) kids.push(el('div', { class: 'empty' }, S.filter.q || S.filter.participant || S.filter.kind !== 'all'
      ? '条件に合う通信はありません。' : 'まだ通信はありません。AIが参加して送信すると、ここに表示されます。'));
    kids.push(...items.map(msgCard));
    refs.list.replaceChildren(...kids);
  }

  function renderNewBtn() {
    refs.newBtn.hidden = !S.newCount;
    refs.newBtn.textContent = `新着 ${S.newCount} 件`;
  }

  function renderAll(fromPoll = false) { renderTop(); renderSide(); renderFilters(fromPoll); renderList(); renderNewBtn(); }

  // ---- ログイン ----
  function showLogin(msg) {
    // ログイン画面の間は定期更新を止める（入力中のフォームを作り直さないように）。進行中の応答も捨てる
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    S.gen += 1;
    app.replaceChildren();
    const input = el('input', { id: 'login-token', type: 'password', autocomplete: 'off', placeholder: 'viewer トークン', 'aria-label': 'viewer トークン' });
    const err = el('div', { class: 'err' }, msg || '');
    const form = el('form', { class: 'login', onsubmit: async e => {
      e.preventDefault();
      try { await api('/api/ui/login', { method: 'POST', body: JSON.stringify({ token: input.value }) }); start(); }
      catch (x) { err.textContent = x.status === 401 ? 'トークンが正しくありません。' : x.message; }
    } },
      el('h1', {}, 'AI通信 モニター'),
      el('p', {}, 'session-mail-admin viewer-token で表示されるトークンを貼り付けてください。トークンはこの端末の中だけで使われます。'),
      input, el('button', { type: 'submit' }, 'ログイン'), err);
    app.append(form);
    input.focus();
  }

  async function logout() {
    try { await api('/api/ui/logout', { method: 'POST', body: '{}' }); } catch { /* 無視 */ }
    showLogin();
  }

  let pollTimer = null;
  async function start() {
    shell();
    try {
      await loadRooms();
      await loadMembers();
      await reload();
    } catch (e) {
      if (e.status === 401) return showLogin();
      S.failures = 2; renderTop();
    }
    if (!SNAP && !pollTimer) pollTimer = setInterval(poll, 2000);
  }

  if (SNAP) { S.lastOk = Date.now(); }
  start();
})();
