// TaskDeck UI. Talks to the local server: GET /api/state, POST /api/<action>, and listens on /events.
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = MD.esc;

  const STATUSES = [
    { id: 'todo', label: 'To do' },
    { id: 'doing', label: 'In progress' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'done', label: 'Done' },
  ];
  const statusLabel = id => (STATUSES.find(s => s.id === id) || STATUSES[0]).label;
  const PRIORITIES = ['None', 'Low', 'Medium', 'High'];
  const DONE_DAYS = 14; // the board's Done column shows the last two weeks

  const I = {
    flag: '<svg class="ico flag" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
    cal: '<svg class="ico" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    note: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/></svg>',
    clock: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
    chev: '<svg class="ico chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    right: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    cmd: '<svg class="ico" viewBox="0 0 24 24"><path d="M5 7l5 5-5 5M12 17h7"/></svg>',
    task: '<svg class="ico" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
    box: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 10h18M10 14h4"/></svg>',
    tag: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/></svg>',
  };

  // ------------------------------------------------------------------ state

  const store = (() => {
    const get = (k, d) => { try { const v = localStorage.getItem('td.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
    const set = (k, v) => { try { localStorage.setItem('td.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
    return { get, set };
  })();

  const S = { tasks: [], timer: null, awake: { mode: 'off', until: 0, active: false }, loaded: false };

  // Same list as the tray menu (TaskDeck.cs AwakeOptions).
  const AWAKE_OPTIONS = [
    { label: 'Off', mode: 'off' },
    { label: 'For 1 hour', mode: 'timed', minutes: 60 },
    { label: 'For 2 hours', mode: 'timed', minutes: 120 },
    { label: 'For 4 hours', mode: 'timed', minutes: 240 },
    { label: 'Until I turn it off', mode: 'on' },
    { label: 'While a focus timer runs', mode: 'focus', hint: 'auto' },
  ];
  const ui = {
    view: store.get('view', 'board'),
    groupBy: store.get('groupBy', 'status'),
    hideDone: store.get('hideDone', false),
    notesMode: store.get('notesMode', 'preview'),
    collapsed: store.get('collapsed', {}),
    search: '',
    tag: null,
    openId: null,
    showAllDone: false,
  };
  let config = { focusMinutes: 25, quickAddHotkey: 'Win+Alt+N' };

  const byId = id => S.tasks.find(t => t.id === id);

  async function api(action, body) {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TaskDeck': '1' },
      body: JSON.stringify(body),
    };
    const res = await fetch('/api/' + action, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    return data;
  }

  async function load() {
    try {
      const data = await api('state');
      S.tasks = data.tasks || [];
      S.timer = data.timer || null;
      S.awake = data.awake || S.awake;
      S.loaded = true;
      render();
    } catch (e) {
      toast('Can’t reach TaskDeck - is it still running?');
    }
  }

  // Local optimistic update, then the server; the SSE "changed" event re-syncs everything afterwards.
  async function update(id, fields) {
    const t = byId(id);
    if (t) {
      if (fields.status && fields.status !== t.status) t.completed = fields.status === 'done' ? Date.now() : 0;
      Object.assign(t, fields, { updated: Date.now() });
      render();
    }
    try { return await api('update', Object.assign({ id }, fields)); }
    catch (e) { toast('Could not save: ' + e.message); load(); }
  }

  function setStatus(id, status, fromEl) {
    const t = byId(id);
    if (!t || t.status === status) return;
    if (status === 'done') celebrate(fromEl);
    if (status !== t.status) {
      // drop to the top of the target column
      const col = S.tasks.filter(x => x.status === status);
      const order = col.length ? Math.min.apply(null, col.map(x => x.order)) - 1000 : 1000;
      update(id, { status, order });
    }
  }

  // ------------------------------------------------------------------ helpers

  const DAY = 86400000;
  const todayISO = () => isoDate(new Date());
  function isoDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function daysUntil(iso) { return Math.round((parseISO(iso) - parseISO(todayISO())) / DAY); }
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); }

  function dueLabel(iso) {
    const n = daysUntil(iso);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    const d = parseISO(iso);
    if (n > 1 && n < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
    if (n < 0 && n > -7) return -n + ' days ago';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  }

  function dueChip(t) {
    if (!t.due) return '';
    const n = daysUntil(t.due);
    const cls = t.status === 'done' ? '' : n < 0 ? ' over' : n === 0 ? ' today' : '';
    return `<span class="chip due${cls}" title="Due ${esc(t.due)}">${I.cal}${esc(dueLabel(t.due))}</span>`;
  }

  function prioChip(p) {
    return p ? `<span class="chip p${p}" title="${PRIORITIES[p]} priority">${I.flag}${PRIORITIES[p]}</span>` : '';
  }

  function duration(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function humanSpent(secs) {
    const m = Math.round(secs / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
  }
  function spentOf(t) {
    let s = t.spent || 0;
    if (S.timer && S.timer.id === t.id) s += (Date.now() - S.timer.start) / 1000;
    return s;
  }

  function timeAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function matches(t) {
    if (ui.tag && !(t.tags || []).includes(ui.tag)) return false;
    const q = ui.search.trim().toLowerCase();
    if (!q) return true;
    const hay = (t.title + ' ' + t.notes + ' ' + (t.tags || []).map(x => '#' + x).join(' ')).toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  }

  function sortTasks(list) {
    return list.slice().sort((a, b) => a.order - b.order || b.created - a.created);
  }

  function debounce(fn, ms) {
    let h;
    const d = function () { const args = arguments; clearTimeout(h); h = setTimeout(() => fn.apply(null, args), ms); };
    d.flush = () => { clearTimeout(h); };
    return d;
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderViewSwitch();
    renderStats();
    renderFilters();
    if (ui.view === 'list') renderList(); else renderBoard();
    renderTimer();
    renderAwake();
    if (ui.openId) renderDrawer(false);
  }

  function renderViewSwitch() {
    $$('#viewSwitch button').forEach(b => b.classList.toggle('on', b.dataset.view === ui.view));
  }

  function renderStats() {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(-i));
    const counts = days.map(d => S.tasks.filter(t => t.status === 'done' && t.completed && isoDate(new Date(t.completed)) === d).length);
    const max = Math.max(1, Math.max.apply(null, counts));
    // streak: consecutive days with at least one completion, counting back from today (or yesterday)
    let streak = 0;
    const doneDays = new Set(S.tasks.filter(t => t.completed).map(t => isoDate(new Date(t.completed))));
    for (let i = doneDays.has(todayISO()) ? 0 : 1; doneDays.has(addDays(-i)); i++) streak++;
    const open = S.tasks.filter(t => t.status !== 'done').length;
    $('#stats').innerHTML =
      `<span><b>${counts[6]}</b> done today</span>` +
      `<span class="spark">${counts.map((c, i) => `<i class="${i === 6 ? 'today' : ''}" style="height:${3 + c / max * 19}px" title="${days[i]}: ${c}"></i>`).join('')}</span>` +
      (streak > 1 ? `<span class="streak" title="Days in a row with something done">🔥 ${streak}</span>` : '') +
      `<span><b>${open}</b> open</span>`;
  }

  function renderFilters() {
    const counts = {};
    S.tasks.forEach(t => (t.tags || []).forEach(tag => { if (t.status !== 'done') counts[tag] = (counts[tag] || 0) + 1; }));
    if (ui.tag && !(ui.tag in counts)) counts[ui.tag] = 0;
    const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    let html = tags.length ? `<span class="label">${I.tag}</span>` : '';
    html += tags.map(tag => `<button class="chip${ui.tag === tag ? ' on' : ''}" data-tag="${esc(tag)}">#${esc(tag)} <small>${counts[tag]}</small></button>`).join('');
    if (ui.view === 'list') {
      html += `<span class="right">
        <span class="label">Group by</span>
        <span class="seg" id="groupSwitch"><button data-group="status" class="${ui.groupBy === 'status' ? 'on' : ''}">Status</button><button data-group="due" class="${ui.groupBy === 'due' ? 'on' : ''}">Due date</button><button data-group="tag" class="${ui.groupBy === 'tag' ? 'on' : ''}">Tag</button></span>
        <button class="toggle${ui.hideDone ? ' on' : ''}" id="hideDone">${ui.hideDone ? 'Done hidden' : 'Hide done'}</button>
      </span>`;
    }
    $('#filters').innerHTML = html;
  }

  function cardMeta(t, compact) {
    const cl = MD.checklist(t.notes);
    let html = prioChip(t.priority) + dueChip(t);
    if (cl.total) {
      html += `<span class="chip checklist${cl.done === cl.total ? ' complete' : ''}" title="Checklist">` +
        `<span class="progress"><i style="width:${cl.done / cl.total * 100}%"></i></span>${cl.done}/${cl.total}</span>`;
    }
    (t.tags || []).forEach(tag => { html += `<span class="chip tag">#${esc(tag)}</span>`; });
    const spent = spentOf(t);
    if (spent >= 60) html += `<span class="chip plain" title="Focus time">${I.clock}${humanSpent(spent)}</span>`;
    if (compact && t.notes.trim() && !cl.total) html += `<span class="chip plain" title="Has notes">${I.note}</span>`;
    return html;
  }

  function renderBoard() {
    const view = $('#view');
    const keepScroll = {};
    $$('.col-body', view).forEach(b => { keepScroll[b.dataset.status] = b.scrollTop; });
    const adding = $('.col-add input', view);
    const addingState = adding ? { status: adding.closest('.col').dataset.status, value: adding.value } : null;

    const cutoff = Date.now() - DONE_DAYS * DAY;
    let html = '<div class="board">';
    for (const st of STATUSES) {
      let list = sortTasks(S.tasks.filter(t => t.status === st.id && matches(t)));
      let hidden = 0;
      if (st.id === 'done') {
        list.sort((a, b) => (b.completed || 0) - (a.completed || 0));
        if (!ui.showAllDone && !ui.search) {
          const recent = list.filter(t => (t.completed || t.updated) >= cutoff);
          hidden = list.length - recent.length;
          list = recent;
        }
      }
      html += `<section class="col" data-status="${st.id}">
        <div class="col-head"><span class="dot ${st.id}"></span>${st.label}<span class="count">${list.length}</span>
          <button class="add" data-add="${st.id}" title="Add to ${st.label}">${I.plus}</button></div>
        <div class="col-body" data-status="${st.id}">`;
      if (addingState && addingState.status === st.id) html += `<div class="col-add"><input placeholder="Title, #tags, !prio, @date… Enter to add"></div>`;
      html += list.map(card).join('');
      if (!list.length && !(addingState && addingState.status === st.id)) {
        html += `<div class="col-empty">${ui.search || ui.tag ? 'Nothing matches' : st.id === 'done' ? 'Finished tasks land here' : 'Drop tasks here'}</div>`;
      }
      if (hidden) html += `<button class="col-more" data-showdone>+ ${hidden} older</button>`;
      html += '</div></section>';
    }
    html += '</div>';
    view.innerHTML = html;
    $$('.col-body', view).forEach(b => { b.scrollTop = keepScroll[b.dataset.status] || 0; });
    if (addingState) {
      const inp = $('.col-add input', view);
      inp.value = addingState.value;
      inp.focus();
    }
  }

  function card(t) {
    const excerpt = MD.excerpt(t.notes, 120);
    const focusing = S.timer && S.timer.id === t.id;
    return `<article class="card p${t.priority || 0}${t.status === 'done' ? ' done' : ''}${ui.openId === t.id ? ' selected' : ''}" draggable="true" data-id="${t.id}">
      <div class="title">${esc(t.title)}</div>
      ${excerpt && !MD.checklist(t.notes).total ? `<div class="excerpt">${esc(excerpt)}</div>` : ''}
      <div class="meta">${cardMeta(t)}</div>
      ${focusing ? '<span class="pulse focusing" title="Focus timer running"></span>' : ''}
      ${t.status !== 'done' ? `<button class="advance" data-advance="${t.id}" title="${t.status === 'doing' || t.status === 'waiting' ? 'Mark done' : 'Start'}">${t.status === 'todo' ? I.arrow : I.check}</button>` : ''}
    </article>`;
  }

  function dueGroup(t) {
    if (!t.due) return 'none';
    const n = daysUntil(t.due);
    if (n < 0) return 'over';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 7) return 'week';
    return 'later';
  }
  const DUE_GROUPS = [
    { id: 'over', label: 'Overdue' }, { id: 'today', label: 'Today' }, { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'week', label: 'Next 7 days' }, { id: 'later', label: 'Later' }, { id: 'none', label: 'No due date' },
  ];

  function renderList() {
    const view = $('#view');
    const scroll = view.scrollTop;
    let tasks = S.tasks.filter(matches);
    if (ui.hideDone) tasks = tasks.filter(t => t.status !== 'done');
    let groups;
    if (ui.groupBy === 'due') {
      const open = tasks.filter(t => t.status !== 'done');
      groups = DUE_GROUPS.map(g => ({ id: 'due-' + g.id, label: g.label, items: open.filter(t => dueGroup(t) === g.id) }));
      if (!ui.hideDone) groups.push({ id: 'due-done', label: 'Done', dot: 'done', items: tasks.filter(t => t.status === 'done') });
    } else if (ui.groupBy === 'tag') {
      const tags = Array.from(new Set(tasks.flatMap(t => t.tags || []))).sort();
      groups = tags.map(tag => ({ id: 'tag-' + tag, label: '#' + tag, items: tasks.filter(t => (t.tags || []).includes(tag)) }));
      groups.push({ id: 'tag-none', label: 'No tag', items: tasks.filter(t => !(t.tags || []).length) });
    } else {
      groups = STATUSES.map(s => ({ id: 'st-' + s.id, label: s.label, dot: s.id, items: tasks.filter(t => t.status === s.id) }));
    }
    groups.forEach(g => {
      g.items.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.priority || 0) - (a.priority || 0) ||
        (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order);
      if (g.dot === 'done' || g.id === 'st-done') g.items.sort((a, b) => (b.completed || 0) - (a.completed || 0));
    });
    groups = groups.filter(g => g.items.length);

    if (!groups.length) {
      view.innerHTML = `<div class="empty-state">${I.box}<b>${ui.search || ui.tag ? 'Nothing matches' : 'All clear'}</b>${ui.search || ui.tag ? 'Try another search or clear the tag filter.' : 'Add a task in the bar above, or press ' + esc(config.quickAddHotkey) + ' anywhere.'}</div>`;
      return;
    }
    view.innerHTML = '<div class="list">' + groups.map(g => `
      <section class="group${ui.collapsed[g.id] ? ' collapsed' : ''}" data-group="${esc(g.id)}">
        <button class="group-head">${I.chev}${g.dot ? `<span class="dot ${g.dot}"></span>` : ''}${esc(g.label)}<span class="count">${g.items.length}</span></button>
        <div class="rows">${g.items.map(row).join('')}</div>
      </section>`).join('') + '</div>';
    view.scrollTop = scroll;
  }

  function row(t) {
    const done = t.status === 'done';
    return `<div class="row${done ? ' done' : ''}${ui.openId === t.id ? ' selected' : ''}" data-id="${t.id}">
      <button class="check${done ? ' on' : ''}" data-toggle="${t.id}" title="${done ? 'Mark not done' : 'Mark done'}">${I.check}</button>
      <div class="row-main"><div class="title">${esc(t.title)}</div></div>
      <div class="meta">${cardMeta(t, true)}${ui.groupBy !== 'status' ? `<span class="chip status"><span class="dot ${t.status}"></span>${statusLabel(t.status)}</span>` : ''}</div>
    </div>`;
  }

  // ------------------------------------------------------------------ timer

  function renderTimer() {
    const pill = $('#timerPill');
    const t = S.timer && byId(S.timer.id);
    pill.hidden = !t;
    if (!t) return;
    const secs = (Date.now() - S.timer.start) / 1000;
    $('#timerTime').textContent = duration(secs);
    $('#timerTask').textContent = t.title;
    pill.classList.toggle('over', secs >= config.focusMinutes * 60);
    const btn = $('#focusBtn');
    if (btn && ui.openId === t.id) btn.querySelector('span').textContent = 'Stop · ' + duration(secs);
  }
  setInterval(() => { if (S.timer) renderTimer(); if (S.awake.mode === 'timed') renderAwake(); }, 1000);

  // ------------------------------------------------------------------ keep awake

  function awakeLeft() {
    const mins = Math.max(0, Math.ceil((S.awake.until - Date.now()) / 60000));
    return mins >= 60 ? Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm' : mins + ' min';
  }

  function renderAwake() {
    const a = S.awake;
    const btn = $('#awakeBtn');
    btn.classList.toggle('on', !!a.active);
    btn.classList.toggle('armed', a.mode === 'focus' && !a.active);
    let label = '', title = 'Keep the screen awake: stops sleep and the lock screen';
    if (a.mode === 'on') { label = 'Awake'; title = 'Screen kept awake until you turn it off'; }
    else if (a.mode === 'timed') {
      label = awakeLeft();
      title = 'Screen kept awake until ' + new Date(a.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } else if (a.mode === 'focus') { label = a.active ? 'Awake' : ''; title = 'Screen kept awake while a focus timer runs'; }
    $('#awakeLabel').textContent = label;
    btn.title = title;
    if (!$('#awakeMenu').hidden) renderAwakeMenu();
  }

  function renderAwakeMenu() {
    const a = S.awake;
    const status = a.mode === 'timed' ? 'On until ' + new Date(a.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' (' + awakeLeft() + ' left)'
      : a.mode === 'on' ? 'On until you turn it off'
      : a.mode === 'focus' ? (a.active ? 'On - a focus timer is running' : 'Turns on with the focus timer')
      : 'Stops sleep and the lock screen, like a video playing.';
    $('#awakeMenu').innerHTML = `<div class="menu-head"><b>Keep screen awake</b><small>${esc(status)}</small></div>` +
      AWAKE_OPTIONS.map((o, i) => {
        const on = o.mode === a.mode && o.mode !== 'timed'; // timed: the header line shows the end time
        return `<button data-awake="${i}" class="${on ? 'on' : ''}"><svg class="tick" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>${esc(o.label)}</button>`;
      }).join('');
  }

  function toggleAwakeMenu(force) {
    const menu = $('#awakeMenu');
    const show = force === undefined ? menu.hidden : force;
    if (show) renderAwakeMenu();
    menu.hidden = !show;
  }

  async function setAwake(opt) {
    S.awake = {
      mode: opt.mode,
      until: opt.mode === 'timed' ? Date.now() + opt.minutes * 60000 : 0,
      active: opt.mode === 'on' || opt.mode === 'timed' || (opt.mode === 'focus' && !!S.timer),
    };
    renderAwake();
    try { await api('awake', { mode: opt.mode, minutes: opt.minutes || 0 }); }
    catch (e) { toast('Could not change keep-awake: ' + e.message); load(); }
  }

  async function startTimer(id) {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    S.timer = { id, start: Date.now() };
    const t = byId(id);
    if (t && (t.status === 'todo' || t.status === 'waiting')) t.status = 'doing';
    render();
    await api('timer', { action: 'start', id }).catch(e => toast(e.message));
  }
  async function stopTimer() {
    if (S.timer) {
      const t = byId(S.timer.id);
      const secs = (Date.now() - S.timer.start) / 1000;
      if (t) t.spent = (t.spent || 0) + Math.floor(secs);
      if (secs >= 60) toast(`Logged ${humanSpent(secs)} on “${t ? t.title : 'task'}”`);
    }
    S.timer = null;
    render();
    await api('timer', { action: 'stop' }).catch(e => toast(e.message));
  }

  // ------------------------------------------------------------------ drawer

  let notesDirty = false;
  const saveNotes = debounce(async (id, value) => {
    const t = byId(id);
    if (t) t.notes = value;
    try {
      await api('update', { id, notes: value });
      notesDirty = false;
      const s = $('#savedLabel');
      if (s) { s.textContent = 'Saved'; s.style.opacity = 1; }
    } catch (e) { toast('Notes not saved: ' + e.message); }
  }, 500);

  function openTask(id) {
    if (!byId(id)) return;
    if (ui.openId && ui.openId !== id) flushNotes();
    ui.openId = id;
    history.replaceState(null, '', '#task=' + id);
    renderDrawer(true);
    $('#drawer').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('on');
    $$('.card, .row').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  }

  function closeDrawer() {
    if (!ui.openId) return;
    flushNotes();
    ui.openId = null;
    history.replaceState(null, '', location.pathname);
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('on');
    $$('.card.selected, .row.selected').forEach(el => el.classList.remove('selected'));
  }

  function flushNotes() {
    const ta = $('#notesInput');
    if (ta && notesDirty && ui.openId) {
      saveNotes.flush();
      const t = byId(ui.openId);
      if (t) t.notes = ta.value;
      api('update', { id: ui.openId, notes: ta.value }).catch(() => {});
      notesDirty = false;
    }
  }

  // full=true rebuilds everything; otherwise refresh the parts that can change from outside without
  // touching what the user is typing in.
  function renderDrawer(full) {
    const t = byId(ui.openId);
    const d = $('#drawer');
    if (!t) { closeDrawer(); return; }
    if (!full && d.dataset.id === t.id) {
      const title = $('#dTitle');
      if (document.activeElement !== title) { title.value = t.title; autosize(title); }
      $('#dStatus').innerHTML = statusButtons(t);
      $('#dPrio').innerHTML = prioButtons(t);
      $('#dDue').innerHTML = dueEditor(t);
      if (!d.contains(document.activeElement) || document.activeElement.id !== 'tagInput') $('#dTags').innerHTML = tagEditor(t);
      $('#dFocus').innerHTML = focusEditor(t);
      $('#dActivity').innerHTML = activity(t);
      $('#dFoot').innerHTML = footer(t);
      const ta = $('#notesInput');
      if (!notesDirty && document.activeElement !== ta && ta.value !== t.notes) { ta.value = t.notes; renderPreview(); }
      return;
    }
    d.dataset.id = t.id;
    notesDirty = false;
    d.innerHTML = `
      <div class="d-head">
        <span class="chip status"><span class="dot ${t.status}"></span>${statusLabel(t.status)}</span>
        <span>Created ${timeAgo(t.created)}</span>
        <span class="grow"></span>
        <button class="icon-btn" id="copyMd" title="Copy task as Markdown">${I.copy}</button>
        <button class="icon-btn" id="dClose" title="Close (Esc)">${I.close}</button>
      </div>
      <div class="d-scroll">
        <textarea class="d-title" id="dTitle" rows="1" spellcheck="true">${esc(t.title)}</textarea>
        <div class="d-props">
          <label>Status</label><div class="pick" id="dStatus">${statusButtons(t)}</div>
          <label>Priority</label><div class="pick" id="dPrio">${prioButtons(t)}</div>
          <label>Due</label><div id="dDue">${dueEditor(t)}</div>
          <label>Tags</label><div id="dTags">${tagEditor(t)}</div>
          <label>Focus</label><div id="dFocus">${focusEditor(t)}</div>
        </div>
        <div class="notes" id="notes">
          <div class="notes-bar">
            <button class="tool" data-md="h" title="Heading">H</button>
            <button class="tool" data-md="b" title="Bold (Ctrl+B)"><b>B</b></button>
            <button class="tool" data-md="i" title="Italic (Ctrl+I)"><i>I</i></button>
            <button class="tool" data-md="link" title="Link (Ctrl+K)"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></button>
            <span class="sep"></span>
            <button class="tool" data-md="ul" title="Bullet list"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg></button>
            <button class="tool" data-md="task" title="Checklist (Ctrl+L)"><svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="6" height="6" rx="1.5"/><path d="M13 7.5h7.5M13 16.5h7.5"/><path d="M4.5 16.5l1.5 1.5 3-3.5"/></svg></button>
            <button class="tool" data-md="code" title="Code"><svg viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg></button>
            <button class="tool" data-md="quote" title="Quote"><svg viewBox="0 0 24 24"><path d="M6 17c-1-1-1.5-2.5-1.5-4C4.5 9.5 7 7 10 6.5M15 17c-1-1-1.5-2.5-1.5-4 0-3.5 2.5-6 5.5-6.5"/></svg></button>
            <span class="grow"></span>
            <span class="saved" id="savedLabel"></span>
            <span class="seg" id="notesMode">
              <button data-mode="write">Write</button><button data-mode="split">Split</button><button data-mode="preview">Preview</button>
            </span>
          </div>
          <div class="notes-body" id="notesBody">
            <textarea id="notesInput" spellcheck="true" placeholder="Notes, links, checklists…  Markdown works.  Paste a screenshot or drop a file to attach it."></textarea>
            <div class="md" id="notesPreview"></div>
          </div>
        </div>
        <details class="activity"><summary>${I.right}Activity</summary><div class="timeline" id="dActivity">${activity(t)}</div></details>
      </div>
      <div class="d-foot" id="dFoot">${footer(t)}</div>`;
    const ta = $('#notesInput');
    ta.value = t.notes;
    setNotesMode(t.notes.trim() ? ui.notesMode : (ui.notesMode === 'preview' ? 'write' : ui.notesMode), true);
    autosize($('#dTitle'));
    renderPreview();
  }

  const statusButtons = t => STATUSES.map(s => `<button class="${s.id}${t.status === s.id ? ' on' : ''}" data-status="${s.id}"><span class="dot ${s.id}"></span>${s.label}</button>`).join('');
  const prioButtons = t => PRIORITIES.map((p, i) => `<button class="p${i}${(t.priority || 0) === i ? ' on' : ''}" data-prio="${i}">${i ? I.flag : ''}${p}</button>`).join('');

  function dueEditor(t) {
    let rel = '';
    if (t.due) {
      const n = daysUntil(t.due);
      rel = `<span class="rel${n < 0 && t.status !== 'done' ? ' over' : ''}">${n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? 'in ' + n + ' days' : -n + ' day' + (n === -1 ? '' : 's') + ' overdue'}</span>`;
    }
    return `<div class="date-row pick">
      <input type="date" id="dueInput" value="${t.due || ''}">
      <button data-due="${todayISO()}">Today</button>
      <button data-due="${addDays(1)}">Tomorrow</button>
      <button data-due="${addDays((8 - new Date().getDay()) % 7 || 7)}">Next Mon</button>
      ${t.due ? '<button data-due="">Clear</button>' : ''}${rel}
    </div>`;
  }

  function tagEditor(t) {
    const all = Array.from(new Set(S.tasks.flatMap(x => x.tags || []))).sort();
    return `<div class="tag-edit" id="tagBox">${(t.tags || []).map(tag => `<span class="chip tag">#${esc(tag)}<button data-untag="${esc(tag)}" title="Remove">×</button></span>`).join('')}
      <input id="tagInput" list="tagList" placeholder="${(t.tags || []).length ? '' : 'Add tags…'}" autocomplete="off">
      <datalist id="tagList">${all.map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>`;
  }

  function focusEditor(t) {
    const running = S.timer && S.timer.id === t.id;
    const spent = spentOf(t);
    return `<div class="focus-row">
      <button class="btn ${running ? 'running' : 'primary'}" id="focusBtn">${running ? I.stop : I.play}<span>${running ? 'Stop · ' + duration((Date.now() - S.timer.start) / 1000) : 'Start focus'}</span></button>
      <span class="spent">${spent >= 60 ? humanSpent(spent) + ' spent so far' : running ? '' : config.focusMinutes + '-minute sessions, time adds up on the task'}</span>
    </div>`;
  }

  function activity(t) {
    return (t.log || []).slice().reverse().map(e => `<div>${esc(e.text)}<time>${timeAgo(e.t)}</time></div>`).join('') || '<div>No activity yet</div>';
  }

  function footer(t) {
    return `<span>Updated ${timeAgo(t.updated)}</span>${t.completed ? `<span>· Done ${timeAgo(t.completed)}</span>` : ''}
      <span class="grow"></span>
      <button class="btn ghost danger" id="deleteBtn">${I.trash}<span>Delete</span></button>`;
  }

  function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

  function setNotesMode(mode, temporary) {
    if (!temporary) { ui.notesMode = mode; store.set('notesMode', mode); }
    $('#notesBody').className = 'notes-body ' + mode;
    $$('#notesMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode !== 'preview') setTimeout(() => $('#notesInput').focus(), 0);
  }

  function renderPreview() {
    const ta = $('#notesInput');
    const pv = $('#notesPreview');
    if (!ta || !pv) return;
    if (ta.value.trim()) { pv.className = 'md'; pv.innerHTML = MD.render(ta.value); }
    else { pv.className = 'md empty'; pv.innerHTML = '<div>No notes yet.<br><small>Click here or press E to write some.</small></div>'; }
  }

  function notesChanged() {
    notesDirty = true;
    const s = $('#savedLabel');
    if (s) { s.textContent = 'Saving…'; }
    renderPreview();
    saveNotes(ui.openId, $('#notesInput').value);
  }

  // ----- markdown editing helpers

  function replaceSelection(ta, before, after, placeholder) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder || '';
    ta.setRangeText(before + sel + after, s, e, 'end');
    if (!ta.value.slice(s, e).length || sel === placeholder) {
      ta.selectionStart = s + before.length;
      ta.selectionEnd = s + before.length + sel.length;
    }
    ta.focus();
    notesChanged();
  }

  // Applies `fn` to every line touched by the selection.
  function mapLines(ta, fn) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd);
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n').map(fn);
    const text = lines.join('\n');
    ta.setRangeText(text, start, end, 'select');
    if (lines.length === 1) ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus();
    notesChanged();
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;

  function mdAction(kind) {
    const ta = $('#notesInput');
    if (ui.notesMode === 'preview' || $('#notesBody').classList.contains('preview')) setNotesMode('split');
    switch (kind) {
      case 'b': return replaceSelection(ta, '**', '**', 'bold');
      case 'i': return replaceSelection(ta, '*', '*', 'italic');
      case 'code': {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        return sel.includes('\n') ? replaceSelection(ta, '```\n', '\n```', '') : replaceSelection(ta, '`', '`', 'code');
      }
      case 'link': {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (/^(https?:\/\/|[a-zA-Z]:\\|\\\\)/.test(sel)) return replaceSelection(ta, '[', '](' + sel + ')', '');
        const s = ta.selectionStart;
        ta.setRangeText('[' + (sel || 'text') + '](https://)', ta.selectionStart, ta.selectionEnd, 'end');
        ta.selectionStart = ta.selectionEnd = s + (sel || 'text').length + 3 + 8;
        ta.focus();
        return notesChanged();
      }
      case 'h': return mapLines(ta, l => (/^#{1,5}\s/.test(l) ? '#' + l : /^######\s/.test(l) ? l.replace(/^#+\s/, '') : '## ' + l));
      case 'quote': return mapLines(ta, l => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : '> ' + l));
      case 'ul': return mapLines(ta, l => (LIST_RE.test(l) ? l.replace(LIST_RE, '$1') : '- ' + l));
      case 'task': return mapLines(ta, l => {
        const m = l.match(LIST_RE);
        if (m && m[3]) return l.replace(LIST_RE, '$1$2 ');
        if (m) return l.replace(LIST_RE, '$1$2 [ ] ');
        return '- [ ] ' + l;
      });
    }
  }

  function notesKeydown(e) {
    const ta = e.target;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'k' || k === 'l') { e.preventDefault(); e.stopPropagation(); mdAction({ b: 'b', i: 'i', k: 'link', l: 'task' }[k]); return; }
      if (k === 's') { e.preventDefault(); flushNotes(); toast('Saved'); return; }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (ta.selectionStart === ta.selectionEnd && !e.shiftKey && !LIST_RE.test(lineAt(ta))) { ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); notesChanged(); return; }
      mapLines(ta, l => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && ta.selectionStart === ta.selectionEnd) {
      const line = lineAt(ta);
      const m = line.match(LIST_RE);
      if (!m) return;
      e.preventDefault();
      const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      if (line.trim() === m[0].trim()) { // empty item: end the list
        ta.setRangeText('', lineStart, lineStart + line.length, 'end');
      } else {
        let marker = m[2];
        if (/\d/.test(marker)) marker = (parseInt(marker, 10) + 1) + marker.slice(-1);
        ta.setRangeText('\n' + m[1] + marker + ' ' + (m[3] ? '[ ] ' : ''), ta.selectionStart, ta.selectionEnd, 'end');
      }
      notesChanged();
    }
  }

  function lineAt(ta) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionStart);
    if (end < 0) end = v.length;
    return v.slice(start, end);
  }

  async function attachFiles(files) {
    const ta = $('#notesInput');
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { toast(file.name + ' is over 25 MB'); continue; }
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const name = file.name && file.name !== 'image.png' ? file.name : 'screenshot.png';
        const res = await api('attach', { name, data });
        const image = /^image\//.test(file.type);
        const label = name.replace(/[[\]]/g, '');
        const md = (image ? `![${label}](${res.url})` : `[${label}](${res.url})`);
        const pre = ta.selectionStart > 0 && ta.value[ta.selectionStart - 1] !== '\n' ? '\n' : '';
        ta.setRangeText(pre + md + '\n', ta.selectionStart, ta.selectionEnd, 'end');
        if ($('#notesBody').classList.contains('preview')) setNotesMode('split');
        notesChanged();
      } catch (e) { toast('Could not attach ' + file.name + ': ' + e.message); }
    }
  }

  // ------------------------------------------------------------------ quick add

  const quick = $('#quick');
  const previewQuick = debounce(async () => {
    const text = quick.value;
    if (!text.trim()) { $('#quickPreview').innerHTML = ''; return; }
    try {
      const p = await api('parse?text=' + encodeURIComponent(text));
      if (quick.value !== text) return;
      let html = '';
      if (p.status !== 'todo') html += `<span class="chip status"><span class="dot ${p.status}"></span>${statusLabel(p.status)}</span>`;
      html += prioChip(p.priority);
      if (p.due) html += dueChip({ due: p.due, status: 'todo' });
      p.tags.forEach(tag => { html += `<span class="chip tag">#${esc(tag)}</span>`; });
      if (p.notes) html += `<span class="chip">${I.note}note</span>`;
      html += `<span class="hint"><kbd>Enter</kbd> add &nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd> add &amp; open</span>`;
      $('#quickPreview').innerHTML = html;
    } catch (e) { /* preview only */ }
  }, 90);

  async function addQuick(text, status, open) {
    if (!text.trim()) return null;
    try {
      const t = await api('quick', { text, status });
      if (!byId(t.id)) S.tasks.push(t);
      render();
      const el = $(`[data-id="${t.id}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      if (open) openTask(t.id);
      return t;
    } catch (e) { toast(e.message); return null; }
  }

  quick.addEventListener('input', previewQuick);
  quick.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = quick.value;
      if (!text.trim()) return;
      quick.value = '';
      $('#quickPreview').innerHTML = '';
      await addQuick(text, null, e.shiftKey);
    } else if (e.key === 'Escape') { quick.value = ''; $('#quickPreview').innerHTML = ''; quick.blur(); }
  });

  // ------------------------------------------------------------------ board drag & drop

  let dragId = null;
  document.addEventListener('dragstart', e => {
    const c = e.target.closest && e.target.closest('.card');
    if (!c) return;
    dragId = c.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => c.classList.add('dragging'));
  });
  document.addEventListener('dragend', () => {
    dragId = null;
    $$('.dragging').forEach(x => x.classList.remove('dragging'));
    $$('.drop-line').forEach(x => x.remove());
    $$('.col.drag-over').forEach(x => x.classList.remove('drag-over'));
  });

  function dropTarget(body, y) {
    const cards = $$('.card:not(.dragging)', body);
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) return c;
    }
    return null;
  }

  document.addEventListener('dragover', e => {
    if (!dragId) return;
    const body = e.target.closest && e.target.closest('.col') && $('.col-body', e.target.closest('.col'));
    if (!body) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.col.drag-over').forEach(x => { if (x !== body.parentElement) x.classList.remove('drag-over'); });
    body.parentElement.classList.add('drag-over');
    const before = dropTarget(body, e.clientY);
    let line = $('.drop-line');
    if (!line) { line = document.createElement('div'); line.className = 'drop-line'; }
    if (before) body.insertBefore(line, before);
    else body.insertBefore(line, $('.col-more', body) || null);
  });

  document.addEventListener('drop', e => {
    if (!dragId) return;
    const col = e.target.closest && e.target.closest('.col');
    if (!col) return;
    e.preventDefault();
    const body = $('.col-body', col);
    const status = col.dataset.status;
    const before = dropTarget(body, e.clientY);
    const ids = $$('.card:not(.dragging)', body).map(c => c.dataset.id);
    const idx = before ? ids.indexOf(before.dataset.id) : ids.length;
    const prev = idx > 0 ? byId(ids[idx - 1]) : null;
    const next = idx < ids.length ? byId(ids[idx]) : null;
    let order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev) order = prev.order + 1000;
    else if (next) order = next.order - 1000;
    else order = 1000;
    const t = byId(dragId);
    const fields = { order };
    if (t.status !== status) {
      fields.status = status;
      if (status === 'done') celebrate(before || body);
    }
    update(dragId, fields);
  });

  // ------------------------------------------------------------------ events

  document.addEventListener('click', e => {
    const el = e.target;

    // links and images inside rendered notes open outside the app
    const a = el.closest('.md a[data-href], .md img[data-href]');
    if (a) {
      e.preventDefault();
      if (a.tagName === 'IMG') { showLightbox(a.getAttribute('src')); return; }
      openLink(a.dataset.href);
      return;
    }
    const copyBtn = el.closest('.md-copy');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.parentElement.querySelector('code').textContent);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      return;
    }

    const awakeOpt = el.closest('[data-awake]');
    if (awakeOpt) { toggleAwakeMenu(false); return setAwake(AWAKE_OPTIONS[+awakeOpt.dataset.awake]); }
    if (el.closest('#awakeBtn')) return toggleAwakeMenu();
    if (!el.closest('#awakeMenu')) toggleAwakeMenu(false);

    const viewBtn = el.closest('#viewSwitch button');
    if (viewBtn) return setView(viewBtn.dataset.view);
    const tagBtn = el.closest('#filters [data-tag]');
    if (tagBtn) { ui.tag = ui.tag === tagBtn.dataset.tag ? null : tagBtn.dataset.tag; return render(); }
    const groupBtn = el.closest('#groupSwitch button');
    if (groupBtn) { ui.groupBy = groupBtn.dataset.group; store.set('groupBy', ui.groupBy); return render(); }
    if (el.closest('#hideDone')) { ui.hideDone = !ui.hideDone; store.set('hideDone', ui.hideDone); return render(); }
    if (el.closest('[data-showdone]')) { ui.showAllDone = true; return render(); }
    if (el.closest('#timerPill')) return stopTimer();
    if (el.closest('#themeBtn')) return toggleTheme();
    if (el.closest('#paletteBtn')) return openPalette();
    if (el.closest('#scrim')) return closeDrawer();

    const addBtn = el.closest('[data-add]');
    if (addBtn) {
      const body = $(`.col-body[data-status="${addBtn.dataset.add}"]`);
      $$('.col-add').forEach(x => x.remove());
      body.insertAdjacentHTML('afterbegin', '<div class="col-add"><input placeholder="Title, #tags, !prio, @date… Enter to add"></div>');
      $$('.col-empty', body).forEach(x => x.remove());
      $('.col-add input', body).focus();
      return;
    }
    const adv = el.closest('[data-advance]');
    if (adv) {
      const t = byId(adv.dataset.advance);
      setStatus(t.id, t.status === 'todo' ? 'doing' : 'done', adv);
      return;
    }
    const tog = el.closest('[data-toggle]');
    if (tog) {
      const t = byId(tog.dataset.toggle);
      setStatus(t.id, t.status === 'done' ? 'todo' : 'done', tog);
      return;
    }
    const gh = el.closest('.group-head');
    if (gh) {
      const id = gh.parentElement.dataset.group;
      ui.collapsed[id] = !ui.collapsed[id];
      store.set('collapsed', ui.collapsed);
      gh.parentElement.classList.toggle('collapsed');
      return;
    }
    const item = el.closest('.card[data-id], .row[data-id]');
    if (item) return openTask(item.dataset.id);

    // ----- drawer
    if (!el.closest('#drawer')) return;
    const t = byId(ui.openId);
    if (!t) return;
    if (el.closest('#dClose')) return closeDrawer();
    const sb = el.closest('[data-status]');
    if (sb && el.closest('#dStatus')) return setStatus(t.id, sb.dataset.status, sb);
    const pb = el.closest('[data-prio]');
    if (pb) return update(t.id, { priority: +pb.dataset.prio });
    const db = el.closest('[data-due]');
    if (db) return update(t.id, { due: db.dataset.due || null });
    const ut = el.closest('[data-untag]');
    if (ut) return update(t.id, { tags: t.tags.filter(x => x !== ut.dataset.untag) });
    if (el.closest('#tagBox') && !el.closest('input')) return $('#tagInput').focus();
    if (el.closest('#focusBtn')) return S.timer && S.timer.id === t.id ? stopTimer() : startTimer(t.id);
    const mb = el.closest('#notesMode button');
    if (mb) return setNotesMode(mb.dataset.mode);
    const tool = el.closest('[data-md]');
    if (tool) return mdAction(tool.dataset.md);
    if (el.closest('#copyMd')) {
      const md = `## ${t.title}\n\n` + [statusLabel(t.status), t.priority ? PRIORITIES[t.priority] + ' priority' : '', t.due ? 'due ' + t.due : '', (t.tags || []).map(x => '#' + x).join(' ')].filter(Boolean).join(' · ') + '\n\n' + t.notes;
      navigator.clipboard.writeText(md.trim() + '\n');
      return toast('Copied as Markdown');
    }
    const del = el.closest('#deleteBtn');
    if (del) {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.querySelector('span').textContent = 'Click again to delete';
        setTimeout(() => { if (del.isConnected) { del.classList.remove('confirm'); del.querySelector('span').textContent = 'Delete'; } }, 3000);
        return;
      }
      return deleteTask(t);
    }
    if (el.closest('#notesPreview.empty')) return setNotesMode(ui.notesMode === 'preview' ? 'write' : ui.notesMode);
  });

  // checkbox in rendered notes -> toggle the source line
  document.addEventListener('change', e => {
    const cb = e.target.closest('.md input[type=checkbox][data-line]');
    if (cb && ui.openId) {
      const ta = $('#notesInput');
      ta.value = MD.toggleLine(ta.value, +cb.dataset.line);
      notesChanged();
      if (cb.checked) {
        const cl = MD.checklist(ta.value);
        if (cl.total && cl.done === cl.total) celebrate(cb);
      }
      return;
    }
    if (e.target.id === 'dueInput') update(ui.openId, { due: e.target.value || null });
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'notesInput') notesChanged();
    else if (e.target.id === 'dTitle') autosize(e.target);
    else if (e.target.id === 'search') { ui.search = e.target.value; render(); }
  });

  document.addEventListener('focusout', e => {
    if (e.target.id === 'dTitle') {
      const t = byId(ui.openId);
      const v = e.target.value.replace(/\s+/g, ' ').trim();
      if (t && v && v !== t.title) update(t.id, { title: v });
      else if (t && !v) e.target.value = t.title;
    }
    if (e.target.id === 'tagInput' && e.target.value.trim()) addTag(e.target.value);
  });

  function addTag(text) {
    const t = byId(ui.openId);
    if (!t) return;
    const add = text.split(/[,\s]+/).map(x => x.replace(/^#/, '').toLowerCase().trim()).filter(Boolean);
    const tags = Array.from(new Set((t.tags || []).concat(add)));
    update(t.id, { tags }).then(() => { const inp = $('#tagInput'); if (inp) inp.focus(); });
  }

  document.addEventListener('keydown', e => {
    const el = e.target;
    if (el.id === 'dTitle' && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
    if (el.id === 'tagInput') {
      if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && el.value.trim()) { e.preventDefault(); const v = el.value; el.value = ''; addTag(v); }
      else if (e.key === 'Backspace' && !el.value) { const t = byId(ui.openId); if (t && t.tags.length) update(t.id, { tags: t.tags.slice(0, -1) }); }
      return;
    }
    if (el.id === 'notesInput') {
      if (e.key === 'Escape') { e.preventDefault(); el.blur(); if (ui.notesMode !== 'write') setNotesMode('preview', true); return; }
      notesKeydown(e);
      return;
    }
    if (el.closest && el.closest('.col-add')) {
      if (e.key === 'Enter' && el.value.trim()) {
        const status = el.closest('.col').dataset.status;
        const text = el.value;
        el.value = '';
        addQuick(text, status, e.shiftKey);
      } else if (e.key === 'Escape' || (e.key === 'Enter' && !el.value.trim())) { el.closest('.col-add').remove(); renderBoard(); }
      return;
    }
    if (el.id === 'search' && e.key === 'Escape') { el.value = ''; ui.search = ''; el.blur(); render(); return; }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (!$('#palette').hidden) return;
    if (!$('#lightbox').hidden && e.key === 'Escape') { $('#lightbox').hidden = true; return; }
    if (!$('#awakeMenu').hidden && e.key === 'Escape') { toggleAwakeMenu(false); return; }
    if (e.key === 'Escape' && ui.openId) { closeDrawer(); return; }

    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); quick.focus(); }
    else if (k === '/') { e.preventDefault(); $('#search').focus(); }
    else if (k === 'b') setView('board');
    else if (k === 'l') setView('list');
    else if (ui.openId && /^[1-4]$/.test(k)) setStatus(ui.openId, STATUSES[+k - 1].id, $(`#dStatus [data-status="${STATUSES[+k - 1].id}"]`));
    else if (ui.openId && k === 'e') { e.preventDefault(); setNotesMode(ui.notesMode === 'preview' ? 'split' : ui.notesMode); }
    else if (ui.openId && k === 'f') { const t = byId(ui.openId); S.timer && S.timer.id === t.id ? stopTimer() : startTimer(t.id); }
  });

  // paste / drop files into notes
  document.addEventListener('paste', e => {
    if (e.target.id !== 'notesInput') return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); attachFiles(files); return; }
    const text = e.clipboardData.getData('text/plain');
    const ta = e.target;
    if (/^https?:\/\/\S+$/.test(text.trim()) && ta.selectionStart !== ta.selectionEnd) {
      e.preventDefault();
      replaceSelection(ta, '[', '](' + text.trim() + ')', '');
    }
  });
  document.addEventListener('dragover', e => {
    const notes = e.target.closest && e.target.closest('#notes');
    if (notes && !dragId && e.dataTransfer.types.includes('Files')) { e.preventDefault(); notes.classList.add('dragover'); }
  });
  document.addEventListener('dragleave', e => {
    const notes = e.target.closest && e.target.closest('#notes');
    if (notes && !notes.contains(e.relatedTarget)) notes.classList.remove('dragover');
  });
  document.addEventListener('drop', e => {
    const notes = e.target.closest && e.target.closest('#notes');
    if (!notes || dragId) return;
    e.preventDefault();
    notes.classList.remove('dragover');
    if (e.dataTransfer.files.length) attachFiles(Array.from(e.dataTransfer.files));
  });
  // a file dropped anywhere else should not navigate the window away
  window.addEventListener('dragover', e => { if (!dragId) e.preventDefault(); });
  window.addEventListener('drop', e => { if (!dragId) e.preventDefault(); });

  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

  async function openLink(href) {
    try { await api('open', { target: href }); }
    catch (e) { toast(e.message); }
  }

  function showLightbox(src) {
    $('#lightbox img').src = src;
    $('#lightbox').hidden = false;
  }

  async function deleteTask(t) {
    const copy = JSON.parse(JSON.stringify(t));
    closeDrawer();
    S.tasks = S.tasks.filter(x => x.id !== t.id);
    if (S.timer && S.timer.id === t.id) S.timer = null;
    render();
    try { await api('delete', { id: t.id }); } catch (e) { toast(e.message); return; }
    toast(`Deleted “${t.title}”`, 'Undo', async () => {
      await api('restore', { task: copy });
      await load();
    });
  }

  function setView(v) {
    if (ui.view === v) return;
    ui.view = v;
    store.set('view', v);
    $('#view').scrollTop = 0;
    render();
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    try { localStorage.setItem('td.theme', next); } catch (e) { /* ignore */ }
    themeIcon();
  }
  function themeIcon() {
    const light = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light';
    $('#themeBtn').innerHTML = light ? I.moon : I.sun;
  }

  // ------------------------------------------------------------------ command palette

  let pItems = [], pIndex = 0;

  function commands() {
    const list = [
      { label: 'New task', key: 'N', run: () => quick.focus() },
      { label: 'Board view', key: 'B', run: () => setView('board') },
      { label: 'List view', key: 'L', run: () => setView('list') },
      { label: 'List grouped by due date', run: () => { ui.groupBy = 'due'; store.set('groupBy', 'due'); setView('list'); render(); } },
      { label: ui.hideDone ? 'Show done tasks in list' : 'Hide done tasks in list', run: () => { ui.hideDone = !ui.hideDone; store.set('hideDone', ui.hideDone); render(); } },
      { label: 'Toggle light / dark theme', run: toggleTheme },
      S.awake.mode === 'off'
        ? { label: 'Keep screen awake (until I turn it off)', run: () => setAwake(AWAKE_OPTIONS[4]) }
        : { label: 'Stop keeping the screen awake', run: () => setAwake(AWAKE_OPTIONS[0]) },
      { label: 'Clear search and filters', run: () => { ui.search = ''; ui.tag = null; $('#search').value = ''; render(); } },
      { label: 'Export tasks as JSON', run: exportJson },
      { label: 'Open data folder', run: () => api('folder', {}) },
    ];
    if (S.timer) list.unshift({ label: 'Stop focus timer', run: stopTimer });
    if (ui.openId) {
      const t = byId(ui.openId);
      STATUSES.filter(s => s.id !== t.status).forEach(s => list.unshift({ label: 'Move to ' + s.label, run: () => setStatus(t.id, s.id) }));
    }
    return list;
  }

  function fuzzy(text, q) {
    if (!q) return { score: 1, html: esc(text) };
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx >= 0) return { score: 100 - idx, html: esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length)) };
    let qi = 0, html = '', score = 0;
    for (let i = 0; i < text.length; i++) {
      if (qi < q.length && lower[i] === q[qi]) { html += '<mark>' + esc(text[i]) + '</mark>'; qi++; score++; }
      else html += esc(text[i]);
    }
    return qi === q.length ? { score, html } : null;
  }

  function renderPalette() {
    const q = $('#paletteInput').value.trim().toLowerCase();
    const cmds = commands().map(c => Object.assign({ type: 'cmd' }, c, { m: fuzzy(c.label, q) })).filter(c => c.m);
    const tasks = S.tasks.map(t => {
      let m = fuzzy(t.title, q);
      if (!m && q && t.notes.toLowerCase().includes(q)) m = { score: 0, html: esc(t.title) };
      return m && { type: 'task', t, m };
    }).filter(Boolean)
      .sort((a, b) => b.m.score - a.m.score || (a.t.status === 'done') - (b.t.status === 'done') || b.t.updated - a.t.updated)
      .slice(0, 30);
    cmds.sort((a, b) => b.m.score - a.m.score);
    pItems = q ? tasks.concat(cmds) : cmds.slice(0, 5).concat(tasks.slice(0, 12));
    pIndex = Math.min(pIndex, Math.max(0, pItems.length - 1));
    let html = '', lastType = null;
    pItems.forEach((it, i) => {
      if (it.type !== lastType) { html += `<div class="p-section">${it.type === 'task' ? 'Tasks' : 'Commands'}</div>`; lastType = it.type; }
      html += it.type === 'task'
        ? `<div class="p-item${i === pIndex ? ' on' : ''}" data-i="${i}"><span class="dot ${it.t.status}"></span><span class="t">${it.m.html}</span><span class="k">${statusLabel(it.t.status)}</span></div>`
        : `<div class="p-item${i === pIndex ? ' on' : ''}" data-i="${i}">${I.cmd}<span class="t">${it.m.html}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}</div>`;
    });
    $('#paletteList').innerHTML = html || '<div class="p-section">No matches - press Enter to create a task</div>';
    const on = $('.p-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    $('#palette').hidden = false;
    $('#paletteInput').value = '';
    pIndex = 0;
    renderPalette();
    $('#paletteInput').focus();
  }
  function closePalette() { $('#palette').hidden = true; }
  function runPalette(i) {
    const it = pItems[i];
    const q = $('#paletteInput').value;
    closePalette();
    if (!it) { if (q.trim()) addQuick(q, null, true); return; }
    if (it.type === 'task') openTask(it.t.id); else it.run();
  }

  $('#paletteInput').addEventListener('input', () => { pIndex = 0; renderPalette(); });
  $('#paletteInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pIndex = Math.min(pItems.length - 1, pIndex + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pIndex = Math.max(0, pIndex - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(pIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  $('#palette').addEventListener('mousedown', e => {
    const it = e.target.closest('.p-item');
    if (it) { e.preventDefault(); runPalette(+it.dataset.i); }
    else if (!e.target.closest('.palette-card')) closePalette();
  });

  function exportJson() {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), tasks: S.tasks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'taskdeck-' + todayISO() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ toasts & confetti

  function toast(text, action, onAction) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${esc(text)}</span>` + (action ? `<button>${esc(action)}</button>` : '');
    if (action) el.querySelector('button').onclick = () => { onAction(); dismiss(); };
    $('#toasts').appendChild(el);
    const timer = setTimeout(dismiss, action ? 6000 : 2800);
    function dismiss() { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 220); }
  }

  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  let parts = [], animating = false;

  function celebrate(fromEl) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = fromEl && fromEl.getBoundingClientRect ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const colors = ['#7c6cff', '#3ccf91', '#f2a93b', '#4c9bff', '#ff5c7a', '#a89cff'];
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 6;
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, life: 60 + Math.random() * 30, age: 0,
        size: 4 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - .5) * .4, c: colors[i % colors.length] });
    }
    if (!animating) { animating = true; requestAnimationFrame(frame); }
  }

  function frame() {
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== innerWidth * dpr) { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter(p => p.age < p.life);
    for (const p of parts) {
      p.age++; p.x += p.vx; p.y += p.vy; p.vy += .25; p.vx *= .98; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (parts.length) requestAnimationFrame(frame);
    else { animating = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // ------------------------------------------------------------------ live updates

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = e => {
      if (e.data === 'changed') load();
      else if (e.data.startsWith('open:')) { load().then(() => openTask(e.data.slice(5))); }
      else if (e.data === 'focusdone') {
        toast(`${config.focusMinutes} minutes of focus - nice. Take a break?`);
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
          new Notification('Focus session done', { body: 'Time for a short break.' });
        }
      }
    };
    es.onopen = () => { if (S.loaded) load(); };
  }

  // refresh relative times ("5 min ago", "Today") now and then
  setInterval(() => { if (!document.hidden && S.loaded && !$('#drawer').contains(document.activeElement)) render(); }, 60000);

  // ------------------------------------------------------------------ start

  themeIcon();
  api('config').then(c => {
    config = c;
    const hk = c.quickAddHotkey ? ` (or ${c.quickAddHotkey} anywhere)` : '';
    quick.placeholder = `Add a task${hk}…   try: Call Anna #finance !high @fri // https://link`;
  }).catch(() => {});
  load().then(() => {
    const m = location.hash.match(/task=([\w-]+)/);
    if (m) openTask(m[1]);
  });
  connect();
})();
