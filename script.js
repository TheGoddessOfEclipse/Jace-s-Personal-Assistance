(() => {
  const STORAGE_KEY = 'teacher_admin_journal_v1';

  // ==================== 初始預設資料 ====================
  function createDefaultClass(name = '英文 A 班', weeks = 6, periods = 4) {
    return {
      id: uid('cls'),
      name,
      weeks,
      periods,
      pinnedSlot: null,
      items: []
    };
  }

  function createDefaultState() {
    const firstClass = createDefaultClass('英文 A 班', 6, 4);
    return {
      secretary: {
        name: '傑森的線上秘書',
        avatar: ''
      },
      teaching: {
        activeClassId: firstClass.id,
        classes: [firstClass]
      },
      sources: [
        { id: 'src_eng', name: '英文教學', color: '#5B6E5C' },
        { id: 'src_hygiene', name: '衛生組業務', color: '#C27A63' },
        { id: 'src_admin', name: '行政交辦', color: '#6E7F91' },
        { id: 'src_self', name: '個人事項', color: '#9C8265' }
      ],
      todos: [],
      events: []
    };
  }

  // ==================== 工具函式 ====================
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function getTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function diffDays(dateStrA, dateStrB) {
    const a = new Date(`${dateStrA}T00:00:00`);
    const b = new Date(`${dateStrB}T00:00:00`);
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  }

  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getContrastColor(hex = '#DDE6D5') {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return '#33302E';
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? '#33302E' : '#FFFFFF';
  }

  function showToast(msg) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 250);
    }, 2300);
  }

  // ==================== 資料載入與相容轉換 ====================
  function migrateAndNormalizeState(parsed) {
    const base = createDefaultState();
    if (!parsed || typeof parsed !== 'object') return base;

    let teaching;
    if (parsed.teaching && Array.isArray(parsed.teaching.classes) && parsed.teaching.classes.length > 0) {
      teaching = parsed.teaching;
      if (!teaching.classes.some(c => c.id === teaching.activeClassId)) {
        teaching.activeClassId = teaching.classes[0].id;
      }
    } else if (parsed.teaching && Array.isArray(parsed.teaching.items)) {
      const migratedClass = createDefaultClass(
        '英文 A 班',
        parsed.teaching.weeks || 6,
        parsed.teaching.periods || 4
      );
      migratedClass.items = parsed.teaching.items.map(item => ({
        ...item,
        completedAt: item.completedAt || null
      }));
      teaching = {
        activeClassId: migratedClass.id,
        classes: [migratedClass]
      };
    } else {
      teaching = base.teaching;
    }

    const secretary = {
      name: (parsed.secretary && parsed.secretary.name) || base.secretary.name,
      avatar: (parsed.secretary && parsed.secretary.avatar) || ''
    };
    const sources = parsed.sources && parsed.sources.length ? parsed.sources : base.sources;
    const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
    const events = Array.isArray(parsed.events) ? parsed.events : [];

    const normalized = { secretary, teaching, sources, todos, events };
    normalizeDailyStates(normalized);
    return normalized;
  }

  function normalizeDailyStates(targetState) {
    const today = getTodayStr();
    targetState.todos.forEach(todo => {
      if (todo.status === 'today_done') {
        if (!todo.todayDoneDate) {
          todo.todayDoneDate = today;
        } else if (todo.todayDoneDate < today) {
          todo.lastWorkedDate = todo.todayDoneDate;
          todo.status = 'not_started';
          todo.todayDoneDate = null;
        }
      }
    });
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();
      return migrateAndNormalizeState(JSON.parse(raw));
    } catch {
      return createDefaultState();
    }
  }

  let state = loadState();
  let currentTodoView = 'active';
  let currentEventView = 'upcoming';

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast('儲存空間已滿，建議縮小秘書圖像檔案或匯出備份');
    }
  }

  function getActiveClass() {
    let cls = state.teaching.classes.find(c => c.id === state.teaching.activeClassId);
    if (!cls) {
      cls = state.teaching.classes[0];
      state.teaching.activeClassId = cls.id;
    }
    return cls;
  }

  // ==================== 頁首、分頁與備份 ====================
  function switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
    if (tabName === 'briefing') renderBriefing();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function initHeader() {
    const today = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    document.getElementById('todayDateDisplay').textContent =
      `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日（週${weekdays[today.getDay()]}）`;

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('[data-jump-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.jumpTab));
    });

    document.getElementById('exportDataBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `傑森的線上秘書備份_${getTodayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已匯出 JSON 備份檔案');
    });

    const fileInput = document.getElementById('importFileInput');
    document.getElementById('importDataBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(reader.result);
          if (!imported.teaching || !imported.sources) throw new Error('格式不符');
          state = migrateAndNormalizeState(imported);
          saveState();
          renderAll();
          showToast('資料已成功還原');
        } catch {
          alert('匯入失敗：請確認檔案為本系統匯出的 JSON 備份檔。');
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    });

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });
  }

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  // ==================== 計算各班「今日進度」與「下堂課進度」 ====================
  function getClassLessonBriefing(cls) {
    const today = getTodayStr();
    const slots = [];

    for (let w = 1; w <= cls.weeks; w++) {
      for (let p = 1; p <= cls.periods; p++) {
        const items = cls.items.filter(
          i => i.location.type === 'cell' && i.location.week === w && i.location.period === p
        );
        slots.push({ week: w, period: p, items });
      }
    }

    let todayIndex = -1;
    let isPinned = false;

    if (cls.pinnedSlot && cls.pinnedSlot.date === today) {
      const idx = slots.findIndex(
        s => s.week === cls.pinnedSlot.week && s.period === cls.pinnedSlot.period
      );
      if (idx !== -1) {
        todayIndex = idx;
        isPinned = true;
      }
    }

    if (todayIndex === -1) {
      todayIndex = slots.findIndex(s =>
        s.items.some(item => !item.completed || item.completedAt === today)
      );
    }

    const todaySlot = todayIndex !== -1 ? slots[todayIndex] : null;
    let nextSlot = null;
    if (todayIndex !== -1) {
      nextSlot = slots.slice(todayIndex + 1).find(s => s.items.length > 0) || null;
    }

    return { todaySlot, nextSlot, isPinned };
  }

  // ==================== 首頁：RPG 個人秘書與整合條列 Briefing ====================
  function initBriefing() {
    // 點擊立繪框上傳圖像（自動縮放並保留透明 PNG 背景）
    const portraitBox = document.getElementById('rpgPortraitBox');
    const avatarInput = document.getElementById('rpgAvatarInput');

    portraitBox.addEventListener('click', () => avatarInput.click());

    avatarInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 520;
          let { width, height } = img;
          if (width > maxSize || height > maxSize) {
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          state.secretary.avatar = canvas.toDataURL(mime, 0.88);
          saveState();
          renderSecretaryBox();
          showToast('已更新個人秘書圖像');
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
      avatarInput.value = '';
    });

    // 修改秘書名稱
    document.getElementById('rpgEditNameBtn').addEventListener('click', () => {
      const nextName = prompt('請輸入個人秘書的名稱或稱呼：', state.secretary.name);
      if (nextName === null) return;
      const trimmed = nextName.trim();
      if (!trimmed) return;
      state.secretary.name = trimmed;
      saveState();
      renderSecretaryBox();
      showToast('已更新秘書稱呼');
    });

    // 移除圖像
    document.getElementById('rpgResetAvatarBtn').addEventListener('click', () => {
      if (!confirm('確定要移除目前的秘書圖像嗎？')) return;
      state.secretary.avatar = '';
      saveState();
      renderSecretaryBox();
      showToast('已移除秘書圖像');
    });

    // 待辦處理詢問 Modal 按鈕
    document.getElementById('resolveTodayDoneBtn').addEventListener('click', () => {
      const id = document.getElementById('resolveTodoId').value;
      const todo = state.todos.find(t => t.id === id);
      if (!todo) return;
      todo.status = 'today_done';
      todo.todayDoneDate = getTodayStr();
      saveState();
      closeModal('todoResolveModal');
      renderAll();
      showToast(`「${todo.title}」已標記今日進度完成，明日將繼續提醒`);
    });

    document.getElementById('resolveCompleteBtn').addEventListener('click', () => {
      const id = document.getElementById('resolveTodoId').value;
      const todo = state.todos.find(t => t.id === id);
      if (!todo) return;
      todo.status = 'completed';
      todo.completedAt = getTodayStr();
      todo.todayDoneDate = null;
      saveState();
      closeModal('todoResolveModal');
      renderAll();
      showToast(`「${todo.title}」已完成並移入歷史備查`);
    });
  }

  function openTodoResolveModal(todo) {
    document.getElementById('resolveTodoId').value = todo.id;
    document.getElementById('resolveTodoTitleDisplay').textContent = todo.title;
    openModal('todoResolveModal');
  }

  function getTimeGreeting() {
    const h = new Date().getHours();
    if (h < 12) return '早安';
    if (h < 18) return '午安';
    return '晚安';
  }

  function renderSecretaryBox(counts = null) {
    const imgEl = document.getElementById('rpgPortraitImg');
    const placeholderEl = document.getElementById('rpgPortraitPlaceholder');
    const resetBtn = document.getElementById('rpgResetAvatarBtn');

    document.getElementById('rpgNameDisplay').textContent = state.secretary.name || '傑森的線上秘書';

    if (state.secretary.avatar) {
      imgEl.src = state.secretary.avatar;
      imgEl.classList.remove('hidden');
      placeholderEl.classList.add('hidden');
      resetBtn.classList.remove('hidden');
    } else {
      imgEl.src = '';
      imgEl.classList.add('hidden');
      placeholderEl.classList.remove('hidden');
      resetBtn.classList.add('hidden');
    }

    if (!counts) return;

    const { teachingPending, eventsCount, todosCount } = counts;
    const totalPending = teachingPending + eventsCount + todosCount;
    const greeting = getTimeGreeting();
    const dialogueEl = document.getElementById('rpgDialogueText');

    if (totalPending === 0) {
      dialogueEl.textContent = `「${greeting}，Jace！今天的教學、七日內活動與待辦事項都已經清空囉。趁現在好好喝杯茶、喘口氣吧。」`;
    } else {
      dialogueEl.textContent = `「${greeting}，Jace！我已經把今天的重點都整理在下方清單裡了——目前還有 ${teachingPending} 項今日教學進度、${eventsCount} 個七日內活動，以及 ${todosCount} 件待辦事項。處理完直接打勾就可以了！」`;
    }

    document.getElementById('rpgSummaryPills').innerHTML = `
      <span class="rpg-stat-pill">今日待教<strong>${teachingPending}</strong>項</span>
      <span class="rpg-stat-pill">七日內活動<strong>${eventsCount}</strong>件</span>
      <span class="rpg-stat-pill">待處理待辦<strong>${todosCount}</strong>件</span>
    `;
  }

  function renderBriefing() {
    normalizeDailyStates(state);
    const today = getTodayStr();
    const listEl = document.getElementById('briefingUnifiedList');
    listEl.innerHTML = '';

    let teachingPending = 0;
    let rowCount = 0;

    // 1. 收集教學進度（各班今日進度 + 下堂課進度）
    state.teaching.classes.forEach(cls => {
      const { todaySlot, nextSlot } = getClassLessonBriefing(cls);

      if (todaySlot && todaySlot.items.length > 0) {
        todaySlot.items.forEach(item => {
          if (!item.completed) teachingPending++;
          rowCount++;
          const li = document.createElement('li');
          li.className = `unified-row${item.completed ? ' is-done' : ''}`;
          li.innerHTML = `
            <label class="unified-check-label">
              <input type="checkbox" class="briefing-checkbox" ${item.completed ? 'checked' : ''} />
              <div class="unified-body">
                <div class="unified-main-line">
                  <span class="origin-tag origin-teaching">來自 教學進度平台</span>
                  <span class="origin-slash">/</span>
                  <span class="unified-sub-pill">${escapeHtml(cls.name)}・今日進度（W${todaySlot.week}-第${todaySlot.period}節）</span>
                  <span class="unified-content-title">
                    <span class="color-dot" style="background:${item.color}"></span>
                    ${escapeHtml(item.name)}${item.type ? `（${escapeHtml(item.type)}）` : ''}
                  </span>
                </div>
                ${item.desc ? `<div class="unified-sub-line">備註：${escapeHtml(item.desc)}</div>` : ''}
              </div>
            </label>
          `;

          li.querySelector('input').addEventListener('change', (e) => {
            item.completed = e.target.checked;
            item.completedAt = item.completed ? getTodayStr() : null;
            saveState();
            renderTeaching();
            renderBriefing();
            showToast(item.completed ? `已標記「${item.name}」完成` : `已恢復「${item.name}」為未完成`);
          });

          listEl.appendChild(li);
        });
      }

      if (nextSlot && nextSlot.items.length > 0) {
        nextSlot.items.forEach(item => {
          rowCount++;
          const li = document.createElement('li');
          li.className = `unified-row is-next-preview${item.completed ? ' is-done' : ''}`;
          li.innerHTML = `
            <label class="unified-check-label">
              <input type="checkbox" class="briefing-checkbox" ${item.completed ? 'checked' : ''} />
              <div class="unified-body">
                <div class="unified-main-line">
                  <span class="origin-tag origin-teaching">來自 教學進度平台</span>
                  <span class="origin-slash">/</span>
                  <span class="unified-sub-pill">${escapeHtml(cls.name)}・下堂課進度（W${nextSlot.week}-第${nextSlot.period}節）</span>
                  <span class="unified-content-title">
                    <span class="color-dot" style="background:${item.color}"></span>
                    ${escapeHtml(item.name)}${item.type ? `（${escapeHtml(item.type)}）` : ''}
                  </span>
                </div>
                ${item.desc ? `<div class="unified-sub-line">備註：${escapeHtml(item.desc)}</div>` : ''}
              </div>
            </label>
          `;

          li.querySelector('input').addEventListener('change', (e) => {
            item.completed = e.target.checked;
            item.completedAt = item.completed ? getTodayStr() : null;
            saveState();
            renderTeaching();
            renderBriefing();
            showToast(item.completed ? `已標記「${item.name}」完成` : `已恢復「${item.name}」為未完成`);
          });

          listEl.appendChild(li);
        });
      }
    });

    // 2. 收集活動提醒（七日內）
    const upcoming7Days = state.events
      .filter(e => !e.archived && e.date >= today && diffDays(today, e.date) <= 7)
      .sort((a, b) => a.date.localeCompare(b.date));

    upcoming7Days.forEach(evt => {
      rowCount++;
      const daysLeft = diffDays(today, evt.date);
      const dayText = daysLeft === 0 ? '就是今天' : daysLeft === 1 ? '明天' : `${daysLeft} 天後`;
      const isUrgent = daysLeft <= 2 || today >= evt.remindDate;
      const metaParts = [
        `日期：${evt.date}`,
        evt.time ? `時間：${evt.time}` : '',
        evt.location ? `地點：${evt.location}` : '',
        evt.note ? `備註：${evt.note}` : ''
      ].filter(Boolean);

      const li = document.createElement('li');
      li.className = 'unified-row';
      li.innerHTML = `
        <label class="unified-check-label">
          <input type="checkbox" class="briefing-checkbox" />
          <div class="unified-body">
            <div class="unified-main-line">
              <span class="origin-tag origin-event">來自 活動提醒平台</span>
              <span class="origin-slash">/</span>
              <span class="unified-content-title">${escapeHtml(evt.name)}</span>
              <span class="unified-sub-pill${isUrgent ? ' urgent' : ''}">${dayText}</span>
            </div>
            <div class="unified-sub-line">${escapeHtml(metaParts.join('｜'))}</div>
          </div>
        </label>
      `;

      li.querySelector('input').addEventListener('change', (e) => {
        if (!e.target.checked) return;
        evt.archived = true;
        evt.archivedAt = getTodayStr();
        saveState();
        renderEvents();
        renderBriefing();
        showToast(`活動「${evt.name}」已撤除並納入歷史備查`);
      });

      listEl.appendChild(li);
    });

    // 3. 收集待辦事項（全列，排除今日已標記「今日進度已完成」者）
    const visibleTodos = state.todos.filter(
      t => t.status !== 'completed' && !(t.status === 'today_done' && t.todayDoneDate === today)
    );
    const hiddenTodayDoneCount = state.todos.filter(
      t => t.status === 'today_done' && t.todayDoneDate === today
    ).length;

    visibleTodos.forEach(todo => {
      rowCount++;
      const src = getSourceById(todo.sourceId);
      const subParts = [
        todo.content ? todo.content : '',
        todo.note ? `備註：${todo.note}` : '',
        todo.lastWorkedDate ? `上次推進：${todo.lastWorkedDate}` : ''
      ].filter(Boolean);

      const li = document.createElement('li');
      li.className = 'unified-row';
      li.style.borderLeft = `4px solid ${src.color}`;
      li.innerHTML = `
        <label class="unified-check-label">
          <input type="checkbox" class="briefing-checkbox" />
          <div class="unified-body">
            <div class="unified-main-line">
              <span class="origin-tag origin-todo">來自 待辦事項平台</span>
              <span class="origin-slash">/</span>
              <span class="source-badge" style="background:${src.color};color:${getContrastColor(src.color)}">${escapeHtml(src.name)}</span>
              <span class="unified-content-title">${escapeHtml(todo.title)}</span>
              <span class="date-tag">（${escapeHtml(todo.date)}）</span>
            </div>
            ${subParts.length ? `<div class="unified-sub-line">${escapeHtml(subParts.join('｜'))}</div>` : ''}
          </div>
        </label>
      `;

      li.querySelector('input').addEventListener('change', (e) => {
        e.target.checked = false;
        openTodoResolveModal(todo);
      });

      listEl.appendChild(li);
    });

    if (rowCount === 0) {
      listEl.innerHTML = '<li class="empty-state">目前沒有待處理的重點事項。可點選上方分頁新增教學進度、待辦或活動提醒。</li>';
    }

    const footnote = document.getElementById('briefingTodoHiddenHint');
    if (hiddenTodayDoneCount > 0) {
      footnote.textContent = `※ 今日已有 ${hiddenTodayDoneCount} 件待辦事項標記為「今日進度已完成」，今日暫不顯示，將於明日自動恢復於此條列中。`;
      footnote.classList.remove('hidden');
    } else {
      footnote.classList.add('hidden');
    }

    renderSecretaryBox({
      teachingPending,
      eventsCount: upcoming7Days.length,
      todosCount: visibleTodos.length
    });
  }

  // ==================== 第一部分：教學進度平台（含多班級切換） ====================
  function initTeaching() {
    document.getElementById('addClassBtn').addEventListener('click', () => {
      document.getElementById('classModalMode').value = 'add';
      document.getElementById('classModalTitle').textContent = '新增班級';
      document.getElementById('classNameInput').value = '';
      openModal('classModal');
      setTimeout(() => document.getElementById('classNameInput').focus(), 50);
    });

    document.getElementById('renameClassBtn').addEventListener('click', () => {
      const cls = getActiveClass();
      document.getElementById('classModalMode').value = 'rename';
      document.getElementById('classModalTitle').textContent = '重新命名班級';
      document.getElementById('classNameInput').value = cls.name;
      openModal('classModal');
      setTimeout(() => document.getElementById('classNameInput').focus(), 50);
    });

    document.getElementById('saveClassModalBtn').addEventListener('click', () => {
      const mode = document.getElementById('classModalMode').value;
      const name = document.getElementById('classNameInput').value.trim();
      if (!name) return showToast('請輸入班級名稱');

      if (mode === 'add') {
        const current = getActiveClass();
        const newCls = createDefaultClass(name, current.weeks, current.periods);
        state.teaching.classes.push(newCls);
        state.teaching.activeClassId = newCls.id;
        showToast(`已新增班級「${name}」`);
      } else {
        const cls = getActiveClass();
        cls.name = name;
        showToast(`班級已更名為「${name}」`);
      }

      saveState();
      closeModal('classModal');
      renderTeaching();
      renderBriefing();
    });

    document.getElementById('deleteClassBtn').addEventListener('click', () => {
      if (state.teaching.classes.length <= 1) {
        return showToast('至少需保留一個班級');
      }
      const cls = getActiveClass();
      if (!confirm(`確定要刪除「${cls.name}」及其所有排課資料嗎？`)) return;
      state.teaching.classes = state.teaching.classes.filter(c => c.id !== cls.id);
      state.teaching.activeClassId = state.teaching.classes[0].id;
      saveState();
      renderTeaching();
      renderBriefing();
      showToast(`已刪除班級「${cls.name}」`);
    });

    document.getElementById('generateTableBtn').addEventListener('click', () => {
      const cls = getActiveClass();
      const weeksInput = document.getElementById('weeksInput');
      const periodsInput = document.getElementById('periodsInput');
      const w = Math.max(1, Math.min(40, parseInt(weeksInput.value, 10) || 1));
      const p = Math.max(1, Math.min(15, parseInt(periodsInput.value, 10) || 1));
      weeksInput.value = w;
      periodsInput.value = p;
      cls.weeks = w;
      cls.periods = p;

      let returnedCount = 0;
      cls.items.forEach(item => {
        if (item.location.type === 'cell' && (item.location.week > w || item.location.period > p)) {
          item.location = { type: 'staging' };
          returnedCount++;
        }
      });

      if (cls.pinnedSlot && (cls.pinnedSlot.week > w || cls.pinnedSlot.period > p)) {
        cls.pinnedSlot = null;
      }

      saveState();
      renderTeaching();
      renderBriefing();
      showToast(
        returnedCount > 0
          ? `「${cls.name}」表格已更新，${returnedCount} 項超出範圍事項已退回待排區`
          : `已更新「${cls.name}」為 ${w} 週 × 每週 ${p} 堂`
      );
    });

    const colorInput = document.getElementById('planColor');
    document.querySelectorAll('#planColorPresets .swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('#planColorPresets .swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        colorInput.value = swatch.dataset.color;
      });
    });
    colorInput.addEventListener('input', () => {
      document.querySelectorAll('#planColorPresets .swatch').forEach(s => s.classList.remove('active'));
    });

    document.getElementById('addPlanItemBtn').addEventListener('click', () => {
      const cls = getActiveClass();
      const nameEl = document.getElementById('planName');
      const typeEl = document.getElementById('planType');
      const descEl = document.getElementById('planDesc');
      const name = nameEl.value.trim();
      if (!name) {
        nameEl.focus();
        return showToast('請輸入待排事項名稱');
      }
      cls.items.push({
        id: uid('plan'),
        name,
        type: typeEl.value.trim(),
        color: colorInput.value,
        desc: descEl.value.trim(),
        completed: false,
        completedAt: null,
        location: { type: 'staging' }
      });
      nameEl.value = '';
      typeEl.value = '';
      descEl.value = '';
      saveState();
      renderTeaching();
      showToast(`已加入「${cls.name}」待排區`);
    });

    document.getElementById('savePlanEditBtn').addEventListener('click', () => {
      const cls = getActiveClass();
      const id = document.getElementById('editPlanId').value;
      const item = cls.items.find(i => i.id === id);
      if (!item) return;
      const newName = document.getElementById('editPlanName').value.trim();
      if (!newName) return showToast('名稱不可為空');

      const wasCompleted = item.completed;
      const nowCompleted = document.getElementById('editPlanCompleted').checked;
      item.name = newName;
      item.type = document.getElementById('editPlanType').value.trim();
      item.color = document.getElementById('editPlanColor').value;
      item.desc = document.getElementById('editPlanDesc').value.trim();
      item.completed = nowCompleted;
      if (!wasCompleted && nowCompleted) item.completedAt = getTodayStr();
      if (!nowCompleted) item.completedAt = null;

      saveState();
      renderTeaching();
      renderBriefing();
      closeModal('planModal');
      showToast('已更新教學事項');
    });

    document.getElementById('deletePlanItemBtn').addEventListener('click', () => {
      const cls = getActiveClass();
      const id = document.getElementById('editPlanId').value;
      if (!confirm('確定要刪除此教學事項嗎？')) return;
      cls.items = cls.items.filter(i => i.id !== id);
      saveState();
      renderTeaching();
      renderBriefing();
      closeModal('planModal');
      showToast('已刪除事項');
    });
  }

  function createPlanChip(item) {
    const chip = document.createElement('div');
    chip.className = `plan-chip${item.completed ? ' completed' : ''}`;
    chip.dataset.itemId = item.id;
    chip.style.backgroundColor = item.color;
    chip.style.color = getContrastColor(item.color);
    chip.title = '拖曳或長按可移位｜點一下標記完成｜點兩下編輯詳情';

    chip.innerHTML = `
      <span class="chip-check">✓</span>
      <span class="chip-name">${escapeHtml(item.name)}</span>
      ${item.type ? `<span class="chip-type">${escapeHtml(item.type)}</span>` : ''}
    `;

    attachChipInteractions(chip, item.id);
    return chip;
  }

  let clickTracker = { id: null, timer: null };

  function attachChipInteractions(chip, itemId) {
    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let ghost = null;
      let currentDropZone = null;
      let longPressTimer = null;

      const beginDrag = (clientX, clientY) => {
        if (isDragging) return;
        isDragging = true;
        chip.classList.add('dragging-source');

        ghost = chip.cloneNode(true);
        ghost.classList.remove('dragging-source');
        ghost.classList.add('drag-ghost');
        ghost.style.width = `${chip.offsetWidth}px`;
        document.body.appendChild(ghost);
        moveGhost(clientX, clientY);
      };

      const moveGhost = (clientX, clientY) => {
        if (!ghost) return;
        ghost.style.left = `${clientX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${clientY - ghost.offsetHeight / 2}px`;

        const elements = document.elementsFromPoint(clientX, clientY);
        const zone = elements.find(el => el.classList && el.classList.contains('drop-zone')) || null;

        if (currentDropZone !== zone) {
          if (currentDropZone) currentDropZone.classList.remove('drag-over');
          currentDropZone = zone;
          if (currentDropZone) currentDropZone.classList.add('drag-over');
        }
      };

      longPressTimer = setTimeout(() => beginDrag(startX, startY), 260);

      const onPointerMove = (moveEvent) => {
        const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!isDragging) {
          if (dist > 8) {
            clearTimeout(longPressTimer);
            if (e.pointerType === 'mouse') {
              beginDrag(moveEvent.clientX, moveEvent.clientY);
            } else {
              cleanup();
            }
          }
        } else {
          moveEvent.preventDefault();
          moveGhost(moveEvent.clientX, moveEvent.clientY);
        }
      };

      const onPointerUp = () => {
        clearTimeout(longPressTimer);

        if (isDragging) {
          if (currentDropZone) {
            const cls = getActiveClass();
            const dropType = currentDropZone.dataset.dropType;
            const item = cls.items.find(i => i.id === itemId);
            if (item) {
              if (dropType === 'staging') {
                item.location = { type: 'staging' };
              } else if (dropType === 'cell') {
                item.location = {
                  type: 'cell',
                  week: parseInt(currentDropZone.dataset.week, 10),
                  period: parseInt(currentDropZone.dataset.period, 10)
                };
              }
              cls.items = cls.items.filter(i => i.id !== itemId);
              cls.items.push(item);
              saveState();
              renderTeaching();
              renderBriefing();
            }
          }
        } else {
          if (clickTracker.id === itemId && clickTracker.timer) {
            clearTimeout(clickTracker.timer);
            clickTracker = { id: null, timer: null };
            openPlanEditModal(itemId);
          } else {
            if (clickTracker.timer) clearTimeout(clickTracker.timer);
            clickTracker.id = itemId;
            clickTracker.timer = setTimeout(() => {
              togglePlanCompleted(itemId);
              clickTracker = { id: null, timer: null };
            }, 230);
          }
        }

        cleanup();
      };

      const cleanup = () => {
        clearTimeout(longPressTimer);
        if (ghost) ghost.remove();
        if (currentDropZone) currentDropZone.classList.remove('drag-over');
        chip.classList.remove('dragging-source');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', cleanup);
      };

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', cleanup);
    });
  }

  function togglePlanCompleted(itemId) {
    const cls = getActiveClass();
    const item = cls.items.find(i => i.id === itemId);
    if (!item) return;
    item.completed = !item.completed;
    item.completedAt = item.completed ? getTodayStr() : null;
    saveState();
    renderTeaching();
    renderBriefing();
  }

  function openPlanEditModal(itemId) {
    const cls = getActiveClass();
    const item = cls.items.find(i => i.id === itemId);
    if (!item) return;
    document.getElementById('editPlanId').value = item.id;
    document.getElementById('editPlanName').value = item.name;
    document.getElementById('editPlanType').value = item.type || '';
    document.getElementById('editPlanColor').value = item.color;
    document.getElementById('editPlanDesc').value = item.desc || '';
    document.getElementById('editPlanCompleted').checked = !!item.completed;
    openModal('planModal');
  }

  function renderTeaching() {
    const cls = getActiveClass();
    const today = getTodayStr();
    const { todaySlot, isPinned } = getClassLessonBriefing(cls);

    const tabsWrap = document.getElementById('classTabsContainer');
    tabsWrap.innerHTML = '';
    state.teaching.classes.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `class-tab-btn${c.id === cls.id ? ' active' : ''}`;
      btn.textContent = c.name;
      btn.addEventListener('click', () => {
        state.teaching.activeClassId = c.id;
        saveState();
        renderTeaching();
      });
      tabsWrap.appendChild(btn);
    });

    document.getElementById('activeClassHeading').textContent = `${cls.name}｜進度表設定`;
    document.getElementById('weeksInput').value = cls.weeks;
    document.getElementById('periodsInput').value = cls.periods;

    const stagingList = document.getElementById('stagingList');
    stagingList.innerHTML = '';
    const stagingItems = cls.items.filter(i => i.location.type === 'staging');
    document.getElementById('stagingCount').textContent = stagingItems.length;

    if (stagingItems.length === 0) {
      stagingList.innerHTML = '<div class="empty-drop-hint">尚無待排事項，可於上方新增或由表格拖回此處</div>';
    } else {
      stagingItems.forEach(item => stagingList.appendChild(createPlanChip(item)));
    }

    const tbody = document.getElementById('progressTableBody');
    tbody.innerHTML = '';

    for (let w = 1; w <= cls.weeks; w++) {
      for (let p = 1; p <= cls.periods; p++) {
        const tr = document.createElement('tr');
        const isCurrentTodayRow = todaySlot && todaySlot.week === w && todaySlot.period === p;

        if (p === 1) {
          const tdWeek = document.createElement('td');
          tdWeek.className = 'week-cell';
          tdWeek.rowSpan = cls.periods;
          tdWeek.textContent = `第 ${w} 週`;
          tr.appendChild(tdWeek);
        }

        const tdPeriod = document.createElement('td');
        tdPeriod.className = 'period-cell';
        const pinLabel = isCurrentTodayRow ? (isPinned ? '★ 今日進度' : '● 今日進度') : '設為今日';
        const pinClass = isCurrentTodayRow ? (isPinned ? 'is-pinned' : 'is-auto-today') : '';

        tdPeriod.innerHTML = `
          <div class="period-cell-inner">
            <span>第 ${p} 節</span>
            <button type="button" class="pin-today-btn ${pinClass}" title="指定此節為首頁 Today's Briefing 的今日進度">${pinLabel}</button>
          </div>
        `;

        tdPeriod.querySelector('.pin-today-btn').addEventListener('click', () => {
          if (isPinned && isCurrentTodayRow) {
            cls.pinnedSlot = null;
            showToast('已取消手動釘選，改回自動偵測今日進度');
          } else {
            cls.pinnedSlot = { week: w, period: p, date: today };
            showToast(`已將「${cls.name}」第 ${w} 週第 ${p} 節設為今日進度`);
          }
          saveState();
          renderTeaching();
          renderBriefing();
        });

        tr.appendChild(tdPeriod);

        const tdContent = document.createElement('td');
        tdContent.className = `drop-cell drop-zone${isCurrentTodayRow ? ' today-highlight' : ''}`;
        tdContent.dataset.dropType = 'cell';
        tdContent.dataset.week = w;
        tdContent.dataset.period = p;

        const itemsWrap = document.createElement('div');
        itemsWrap.className = 'cell-items';
        const cellItems = cls.items.filter(
          i => i.location.type === 'cell' && i.location.week === w && i.location.period === p
        );
        cellItems.forEach(item => itemsWrap.appendChild(createPlanChip(item)));

        tdContent.appendChild(itemsWrap);
        tr.appendChild(tdContent);
        tbody.appendChild(tr);
      }
    }
  }

  // ==================== 第二部分：待辦事項平台 ====================
  function initTodo() {
    document.getElementById('todoDate').value = getTodayStr();

    document.getElementById('openSourceModalBtn').addEventListener('click', () => {
      renderSourceManager();
      openModal('sourceModal');
    });

    document.getElementById('addSourceBtn').addEventListener('click', () => {
      const nameEl = document.getElementById('newSourceName');
      const colorEl = document.getElementById('newSourceColor');
      const name = nameEl.value.trim();
      if (!name) return showToast('請輸入來源名稱');
      state.sources.push({ id: uid('src'), name, color: colorEl.value });
      nameEl.value = '';
      saveState();
      renderSourceOptions();
      renderSourceManager();
      renderTodos();
      renderBriefing();
      showToast(`已新增來源「${name}」`);
    });

    document.getElementById('addTodoBtn').addEventListener('click', () => {
      const titleEl = document.getElementById('todoTitle');
      const title = titleEl.value.trim();
      if (!title) {
        titleEl.focus();
        return showToast('請輸入事項名稱');
      }
      state.todos.unshift({
        id: uid('todo'),
        date: document.getElementById('todoDate').value || getTodayStr(),
        title,
        sourceId: document.getElementById('todoSource').value,
        content: document.getElementById('todoContent').value.trim(),
        note: document.getElementById('todoNote').value.trim(),
        status: 'not_started',
        todayDoneDate: null,
        lastWorkedDate: null,
        completedAt: null
      });
      titleEl.value = '';
      document.getElementById('todoContent').value = '';
      document.getElementById('todoNote').value = '';
      saveState();
      renderTodos();
      renderBriefing();
      showToast('已新增待辦事項');
    });

    document.querySelectorAll('[data-todo-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-todo-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTodoView = btn.dataset.todoView;
        document.getElementById('todoActiveList').classList.toggle('hidden', currentTodoView !== 'active');
        document.getElementById('todoHistoryList').classList.toggle('hidden', currentTodoView !== 'history');
        document.getElementById('todoFilterStatus').classList.toggle('hidden', currentTodoView !== 'active');
      });
    });

    ['todoFilterSource', 'todoFilterStatus', 'todoSearchInput'].forEach(id => {
      document.getElementById(id).addEventListener('input', renderTodos);
    });

    document.getElementById('saveTodoEditBtn').addEventListener('click', () => {
      const id = document.getElementById('editTodoId').value;
      const todo = state.todos.find(t => t.id === id);
      if (!todo) return;
      const title = document.getElementById('editTodoTitle').value.trim();
      if (!title) return showToast('事項名稱不可為空');
      todo.date = document.getElementById('editTodoDate').value;
      todo.sourceId = document.getElementById('editTodoSource').value;
      todo.title = title;
      todo.content = document.getElementById('editTodoContent').value.trim();
      todo.note = document.getElementById('editTodoNote').value.trim();
      saveState();
      renderTodos();
      renderBriefing();
      closeModal('todoEditModal');
      showToast('已更新待辦事項');
    });
  }

  function getSourceById(sourceId) {
    return state.sources.find(s => s.id === sourceId) || { name: '未分類', color: '#8C857D' };
  }

  function renderSourceOptions() {
    const selects = [
      document.getElementById('todoSource'),
      document.getElementById('editTodoSource')
    ];
    selects.forEach(sel => {
      const prev = sel.value;
      sel.innerHTML = state.sources
        .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
        .join('');
      if (state.sources.some(s => s.id === prev)) sel.value = prev;
    });

    const filterSel = document.getElementById('todoFilterSource');
    const prevFilter = filterSel.value;
    filterSel.innerHTML = '<option value="all">全部來源</option>' +
      state.sources.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    filterSel.value = state.sources.some(s => s.id === prevFilter) ? prevFilter : 'all';
  }

  function renderSourceManager() {
    const list = document.getElementById('sourceManagerList');
    list.innerHTML = '';
    state.sources.forEach(src => {
      const row = document.createElement('div');
      row.className = 'source-row';
      row.innerHTML = `
        <div class="source-row-left">
          <input type="color" value="${src.color}" data-src-color="${src.id}" />
          <input type="text" value="${escapeHtml(src.name)}" data-src-name="${src.id}" />
        </div>
        <button type="button" class="text-btn danger" data-src-del="${src.id}">刪除</button>
      `;

      row.querySelector('[data-src-color]').addEventListener('change', (e) => {
        src.color = e.target.value;
        saveState();
        renderTodos();
        renderBriefing();
      });

      row.querySelector('[data-src-name]').addEventListener('change', (e) => {
        const val = e.target.value.trim();
        if (!val) return (e.target.value = src.name);
        src.name = val;
        saveState();
        renderSourceOptions();
        renderTodos();
        renderBriefing();
      });

      row.querySelector('[data-src-del]').addEventListener('click', () => {
        if (state.sources.length <= 1) return showToast('至少需保留一個任務來源');
        if (!confirm(`確定刪除來源「${src.name}」嗎？`)) return;
        state.sources = state.sources.filter(s => s.id !== src.id);
        saveState();
        renderSourceOptions();
        renderSourceManager();
        renderTodos();
        renderBriefing();
      });

      list.appendChild(row);
    });
  }

  function renderTodos() {
    normalizeDailyStates(state);
    const filterSource = document.getElementById('todoFilterSource').value;
    const filterStatus = document.getElementById('todoFilterStatus').value;
    const keyword = document.getElementById('todoSearchInput').value.trim().toLowerCase();

    const activeAll = state.todos.filter(t => t.status !== 'completed');
    const historyAll = state.todos.filter(t => t.status === 'completed');

    document.getElementById('todoActiveCount').textContent = activeAll.length;
    document.getElementById('todoHistoryCount').textContent = historyAll.length;

    const matchSearch = (t) => {
      if (filterSource !== 'all' && t.sourceId !== filterSource) return false;
      if (!keyword) return true;
      const src = getSourceById(t.sourceId).name.toLowerCase();
      return (
        t.title.toLowerCase().includes(keyword) ||
        (t.content || '').toLowerCase().includes(keyword) ||
        (t.note || '').toLowerCase().includes(keyword) ||
        src.includes(keyword)
      );
    };

    const activeFiltered = activeAll.filter(t => matchSearch(t) && (filterStatus === 'all' || t.status === filterStatus));
    const activeContainer = document.getElementById('todoActiveList');
    activeContainer.innerHTML = '';

    if (activeFiltered.length === 0) {
      activeContainer.innerHTML = '<div class="empty-state">目前沒有符合條件的待辦事項。</div>';
    } else {
      activeFiltered.forEach(todo => {
        const src = getSourceById(todo.sourceId);
        const card = document.createElement('article');
        card.className = `todo-card${todo.status === 'today_done' ? ' today-done' : ''}`;
        card.style.borderLeftColor = src.color;

        card.innerHTML = `
          <div class="card-top">
            <div>
              <div class="card-meta">
                <span class="source-badge" style="background:${src.color};color:${getContrastColor(src.color)}">${escapeHtml(src.name)}</span>
                <span class="date-tag">建立日期：${escapeHtml(todo.date)}</span>
              </div>
              <div class="card-title" style="margin-top:6px;">${escapeHtml(todo.title)}</div>
            </div>
            <div class="icon-actions">
              <button type="button" class="text-btn" data-edit="${todo.id}">編輯</button>
              <button type="button" class="text-btn danger" data-del="${todo.id}">刪除</button>
            </div>
          </div>
          ${todo.content ? `<div class="card-body">${escapeHtml(todo.content)}</div>` : ''}
          ${todo.note ? `<div class="card-note">備註：${escapeHtml(todo.note)}</div>` : ''}
          <div class="card-actions-bar">
            <div class="status-pills">
              <button type="button" class="status-btn ${todo.status === 'not_started' ? 'active-not-started' : ''}" data-status="not_started">未開始</button>
              <button type="button" class="status-btn ${todo.status === 'today_done' ? 'active-today-done' : ''}" data-status="today_done">今日進度已完成</button>
              <button type="button" class="status-btn complete-action" data-status="completed">✓ 標記已完成（移入歷史）</button>
            </div>
          </div>
        `;

        card.querySelectorAll('[data-status]').forEach(btn => {
          btn.addEventListener('click', () => {
            const nextStatus = btn.dataset.status;
            todo.status = nextStatus;
            if (nextStatus === 'today_done') {
              todo.todayDoneDate = getTodayStr();
              showToast(`「${todo.title}」今日不再於首頁顯示，明日自動恢復`);
            } else if (nextStatus === 'completed') {
              todo.completedAt = getTodayStr();
              todo.todayDoneDate = null;
              showToast(`「${todo.title}」已完成並移入歷史備查`);
            } else {
              todo.todayDoneDate = null;
            }
            saveState();
            renderTodos();
            renderBriefing();
          });
        });

        card.querySelector('[data-edit]').addEventListener('click', () => openTodoEditModal(todo));
        card.querySelector('[data-del]').addEventListener('click', () => {
          if (!confirm(`確定刪除「${todo.title}」？`)) return;
          state.todos = state.todos.filter(t => t.id !== todo.id);
          saveState();
          renderTodos();
          renderBriefing();
        });

        activeContainer.appendChild(card);
      });
    }

    const historyFiltered = historyAll.filter(matchSearch);
    const historyContainer = document.getElementById('todoHistoryList');
    historyContainer.innerHTML = '';

    if (historyFiltered.length === 0) {
      historyContainer.innerHTML = '<div class="empty-state">目前尚無已完成的歷史紀錄。</div>';
    } else {
      historyFiltered.forEach(todo => {
        const src = getSourceById(todo.sourceId);
        const card = document.createElement('article');
        card.className = 'todo-card history-card';
        card.style.borderLeftColor = src.color;

        card.innerHTML = `
          <div class="card-top">
            <div>
              <div class="card-meta">
                <span class="source-badge" style="background:${src.color};color:${getContrastColor(src.color)}">${escapeHtml(src.name)}</span>
                <span class="date-tag">建立：${escapeHtml(todo.date)}｜完成：${escapeHtml(todo.completedAt || '-')}</span>
              </div>
              <div class="card-title" style="margin-top:6px;">${escapeHtml(todo.title)}</div>
            </div>
            <div class="icon-actions">
              <button type="button" class="text-btn" data-restore="${todo.id}">復原至待辦</button>
              <button type="button" class="text-btn danger" data-del="${todo.id}">永久刪除</button>
            </div>
          </div>
          ${todo.content ? `<div class="card-body">${escapeHtml(todo.content)}</div>` : ''}
          ${todo.note ? `<div class="card-note">備註：${escapeHtml(todo.note)}</div>` : ''}
        `;

        card.querySelector('[data-restore]').addEventListener('click', () => {
          todo.status = 'not_started';
          todo.completedAt = null;
          todo.todayDoneDate = null;
          saveState();
          renderTodos();
          renderBriefing();
          showToast('已復原至進行中待辦');
        });

        card.querySelector('[data-del]').addEventListener('click', () => {
          if (!confirm(`確定永久刪除歷史紀錄「${todo.title}」？`)) return;
          state.todos = state.todos.filter(t => t.id !== todo.id);
          saveState();
          renderTodos();
        });

        historyContainer.appendChild(card);
      });
    }
  }

  function openTodoEditModal(todo) {
    document.getElementById('editTodoId').value = todo.id;
    document.getElementById('editTodoDate').value = todo.date;
    document.getElementById('editTodoSource').value = todo.sourceId;
    document.getElementById('editTodoTitle').value = todo.title;
    document.getElementById('editTodoContent').value = todo.content || '';
    document.getElementById('editTodoNote').value = todo.note || '';
    openModal('todoEditModal');
  }

  // ==================== 第三部分：活動提醒平台 ====================
  function initEvents() {
    const today = getTodayStr();
    document.getElementById('eventDate').value = today;
    document.getElementById('eventRemindDate').value = today;

    document.getElementById('addEventBtn').addEventListener('click', () => {
      const nameEl = document.getElementById('eventName');
      const dateEl = document.getElementById('eventDate');
      const remindEl = document.getElementById('eventRemindDate');

      const name = nameEl.value.trim();
      if (!name) {
        nameEl.focus();
        return showToast('請輸入活動名稱');
      }
      if (!dateEl.value) return showToast('請選擇發生日期');

      state.events.push({
        id: uid('evt'),
        name,
        date: dateEl.value,
        remindDate: remindEl.value || dateEl.value,
        time: document.getElementById('eventTime').value.trim(),
        location: document.getElementById('eventLocation').value.trim(),
        note: document.getElementById('eventNote').value.trim(),
        archived: false,
        archivedAt: null
      });

      nameEl.value = '';
      document.getElementById('eventTime').value = '';
      document.getElementById('eventLocation').value = '';
      document.getElementById('eventNote').value = '';

      saveState();
      renderEvents();
      renderBriefing();
      showToast(dateEl.value < getTodayStr() ? '活動日期已過，已自動收錄於歷史備查' : '已加入活動提醒');
    });

    document.querySelectorAll('[data-event-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-event-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentEventView = btn.dataset.eventView;
        document.getElementById('eventUpcomingList').classList.toggle('hidden', currentEventView !== 'upcoming');
        document.getElementById('eventHistoryList').classList.toggle('hidden', currentEventView !== 'history');
      });
    });

    document.getElementById('eventSearchInput').addEventListener('input', renderEvents);

    document.getElementById('saveEventEditBtn').addEventListener('click', () => {
      const id = document.getElementById('editEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      const name = document.getElementById('editEventName').value.trim();
      if (!name) return showToast('活動名稱不可為空');

      evt.name = name;
      evt.date = document.getElementById('editEventDate').value;
      evt.remindDate = document.getElementById('editEventRemindDate').value || evt.date;
      evt.time = document.getElementById('editEventTime').value.trim();
      evt.location = document.getElementById('editEventLocation').value.trim();
      evt.note = document.getElementById('editEventNote').value.trim();

      saveState();
      renderEvents();
      renderBriefing();
      closeModal('eventEditModal');
      showToast('已更新活動資訊');
    });
  }

  function renderEvents() {
    const today = getTodayStr();
    const keyword = document.getElementById('eventSearchInput').value.trim().toLowerCase();

    const upcomingAll = state.events
      .filter(e => !e.archived && e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    const historyAll = state.events
      .filter(e => e.archived || e.date < today)
      .sort((a, b) => b.date.localeCompare(a.date));

    document.getElementById('eventUpcomingCount').textContent = upcomingAll.length;
    document.getElementById('eventHistoryCount').textContent = historyAll.length;

    const hasActiveReminder = upcomingAll.some(e => today >= e.remindDate && today <= e.date);
    document.getElementById('eventAlertBadge').classList.toggle('hidden', !hasActiveReminder);

    const matchSearch = (e) => {
      if (!keyword) return true;
      return (
        e.name.toLowerCase().includes(keyword) ||
        (e.location || '').toLowerCase().includes(keyword) ||
        (e.note || '').toLowerCase().includes(keyword)
      );
    };

    const renderList = (items, containerId, isPast) => {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      const filtered = items.filter(matchSearch);

      if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state">${isPast ? '尚無歷史活動紀錄。' : '目前沒有即將到來的活動。'}</div>`;
        return;
      }

      filtered.forEach(evt => {
        const daysLeft = diffDays(today, evt.date);
        const isReminding = !isPast && today >= evt.remindDate;

        let badgeHtml = '';
        if (isPast) {
          badgeHtml = evt.archived
            ? `<span class="event-badge past">已處理歸檔${evt.archivedAt ? `（${escapeHtml(evt.archivedAt)}）` : ''}</span>`
            : '<span class="event-badge past">已結束</span>';
        } else if (daysLeft === 0) {
          badgeHtml = '<span class="event-badge alert">就是今天</span>';
        } else if (isReminding) {
          badgeHtml = `<span class="event-badge alert">提醒中｜倒數 ${daysLeft} 天</span>`;
        } else {
          badgeHtml = `<span class="event-badge normal">距離還有 ${daysLeft} 天</span>`;
        }

        const card = document.createElement('article');
        card.className = `event-card${isReminding ? ' reminding' : ''}`;
        card.innerHTML = `
          <div class="card-top">
            <div>
              <div class="card-meta">
                ${badgeHtml}
                <span class="date-tag">提醒日：${escapeHtml(evt.remindDate)}</span>
              </div>
              <div class="card-title" style="margin-top:6px;">${escapeHtml(evt.name)}</div>
            </div>
            <div class="icon-actions">
              ${!isPast ? `<button type="button" class="text-btn" data-archive="${evt.id}">標記已處理</button>` : ''}
              ${isPast && evt.archived && evt.date >= today ? `<button type="button" class="text-btn" data-unarchive="${evt.id}">復原</button>` : ''}
              <button type="button" class="text-btn" data-edit="${evt.id}">編輯</button>
              <button type="button" class="text-btn danger" data-del="${evt.id}">刪除</button>
            </div>
          </div>
          <div class="event-details-grid">
            <div class="event-detail-item"><strong>發生日期：</strong>${escapeHtml(evt.date)}</div>
            <div class="event-detail-item"><strong>活動時間：</strong>${escapeHtml(evt.time || '未填寫')}</div>
            <div class="event-detail-item"><strong>活動地點：</strong>${escapeHtml(evt.location || '未填寫')}</div>
          </div>
          ${evt.note ? `<div class="card-note">備註：${escapeHtml(evt.note)}</div>` : ''}
        `;

        const archiveBtn = card.querySelector('[data-archive]');
        if (archiveBtn) {
          archiveBtn.addEventListener('click', () => {
            evt.archived = true;
            evt.archivedAt = getTodayStr();
            saveState();
            renderEvents();
            renderBriefing();
            showToast(`「${evt.name}」已納入歷史備查`);
          });
        }

        const unarchiveBtn = card.querySelector('[data-unarchive]');
        if (unarchiveBtn) {
          unarchiveBtn.addEventListener('click', () => {
            evt.archived = false;
            evt.archivedAt = null;
            saveState();
            renderEvents();
            renderBriefing();
            showToast(`已復原活動「${evt.name}」`);
          });
        }

        card.querySelector('[data-edit]').addEventListener('click', () => openEventEditModal(evt));
        card.querySelector('[data-del]').addEventListener('click', () => {
          if (!confirm(`確定刪除活動「${evt.name}」？`)) return;
          state.events = state.events.filter(e => e.id !== evt.id);
          saveState();
          renderEvents();
          renderBriefing();
        });

        container.appendChild(card);
      });
    };

    renderList(upcomingAll, 'eventUpcomingList', false);
    renderList(historyAll, 'eventHistoryList', true);
  }

  function openEventEditModal(evt) {
    document.getElementById('editEventId').value = evt.id;
    document.getElementById('editEventName').value = evt.name;
    document.getElementById('editEventDate').value = evt.date;
    document.getElementById('editEventRemindDate').value = evt.remindDate;
    document.getElementById('editEventTime').value = evt.time || '';
    document.getElementById('editEventLocation').value = evt.location || '';
    document.getElementById('editEventNote').value = evt.note || '';
    openModal('eventEditModal');
  }

  // ==================== 啟動渲染 ====================
  function renderAll() {
    normalizeDailyStates(state);
    renderTeaching();
    renderSourceOptions();
    renderTodos();
    renderEvents();
    renderBriefing();
  }

  initHeader();
  initBriefing();
  initTeaching();
  initTodo();
  initEvents();
  renderAll();
})();