(() => {
  const STORAGE_KEY = 'teacher_admin_journal_v1';

  // ==================== Firebase 設定（共用 Jace's Teaching Lab） ====================
  const firebaseConfig = {
    apiKey: "AIzaSyAp9o7K0rBQgwSMg58e4C1FXy2UZjfCSv4",
    authDomain: "jace-s-teaching-lab.firebaseapp.com",
    databaseURL: "https://jace-s-teaching-lab-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "jace-s-teaching-lab",
    storageBucket: "jace-s-teaching-lab.firebasestorage.app",
    messagingSenderId: "222352360644",
    appId: "1:222352360644:web:693d06971123e5afbcf591"
  };

  // 請填入允許登入此線上秘書的 Gmail
  const ALLOWED_EMAILS = [
    "jwls0202@gmail.com"
  ];

  // 本平台獨立的雲端路徑，不影響 Jace's Teaching Lab 原有資料
  const FIREBASE_PATH = 'jace_personal_assistant/state';

  const DEFAULT_SECRETARY_PERSONA =
    '你是一位幹練、溫暖又帶點機智的個人秘書（RPG 夥伴風格），協助身為國中英文老師兼衛生組長的 Jace 掌握每日節奏。請用繁體中文、自然口語的 2～4 句話（約 80～130 字，不要使用條列符號或 Markdown 星號）彙報今天最該優先處理的事項：主動點出近期急迫活動的時間與地點、今日課堂重點或備註，以及關鍵待辦，最後給一句簡短提振士氣的話。';

  let dbRef = null;
  let isCloudConnected = false;
  let saveTimer = null;
  const CLIENT_ID = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let localSyncSeq = 0;


  // UI 與 AI 狀態
  let currentBriefingView = 'today'; // 'today' | 'history'
  let currentTodoView = 'active';
  let currentEventView = 'upcoming';
  const initNow = new Date();
  let calYear = initNow.getFullYear();
  let calMonth = initNow.getMonth(); // 0-11
  let calSelectedDate = getTodayStr();
  let isMultiSelectMode = false;
  let selectedPlanIds = new Set();

  let isGeneratingAiBriefing = false;
  let hasAutoRefreshedOnLoad = false;
  let lastFailedBriefingHash = '';
  let latestBriefingPayload = null;
  let aiAutoTimer = null;

  function on(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventName, handler);
  }

  function setSyncStatus(statusType, text) {
    const badge = document.getElementById('syncStatusBadge');
    if (!badge) return;
    badge.className = `sync-pill ${statusType}`;
    badge.textContent = text;
  }

  function showAuthError(msg) {
    const el = document.getElementById('authErrorMsg');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

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
        avatar: '',
        apiKey: '',
        model: 'gemini-2.5-flash',
        persona: DEFAULT_SECRETARY_PERSONA,
        lastBriefingText: '',
        lastBriefingHash: ''
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
  let uidSeq = 0;
  function uid(prefix = 'id') {
    uidSeq += 1;
    return `${prefix}_${Date.now()}_${uidSeq}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function toArray(val) {
    if (Array.isArray(val)) return val.filter(Boolean);
    if (val && typeof val === 'object') return Object.values(val).filter(Boolean);
    return [];
  }

  function getTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const ny = dt.getFullYear();
    const nm = String(dt.getMonth() + 1).padStart(2, '0');
    const nd = String(dt.getDate()).padStart(2, '0');
    return `${ny}-${nm}-${nd}`;
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
    if (!container) return;
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

  // ==================== 共用建立副本函式 ====================
  function duplicateTeachingItemToStaging(cls, item) {
    if (!cls || !item) return;
    cls.items.push({
      id: uid('plan'),
      name: item.name,
      type: item.type || '',
      color: item.color || '#DDE6D5',
      desc: item.desc || '',
      completed: false,
      completedAt: null,
      location: { type: 'staging' }
    });
    saveState();
    renderTeaching();
    renderBriefing();
    showToast(`已建立副本「${item.name}」至「${cls.name}」待排區`);
  }

  function duplicateTodoItem(todo) {
    if (!todo) return;
    const newTodo = {
      id: uid('todo'),
      date: getTodayStr(),
      title: todo.title,
      sourceId: todo.sourceId,
      content: todo.content || '',
      note: todo.note || '',
      status: 'not_started',
      todayDoneDate: null,
      lastWorkedDate: null,
      completedAt: null
    };
    state.todos.unshift(newTodo);
    saveState();
    renderTodos();
    renderBriefing();
    showToast(`已建立待辦副本「${newTodo.title}」至進行中清單`);
  }

  function duplicateEventItem(evt) {
    if (!evt) return;
    const today = getTodayStr();
    const newEvt = {
      id: uid('evt'),
      name: evt.name,
      date: today,
      remindDate: today,
      time: evt.time || '',
      location: evt.location || '',
      note: evt.note || '',
      archived: false,
      archivedAt: null,
      snoozeUntil: null
    };
    state.events.push(newEvt);
    saveState();
    renderEvents();
    renderBriefing();
    showToast(`已建立活動副本「${newEvt.name}」，請設定新的活動日期`);
    openEventEditModal(newEvt);
  }

  // ==================== 資料載入、Firebase 空陣列防護與跨日處理 ====================
  function migrateAndNormalizeState(parsed) {
    const base = createDefaultState();
    if (!parsed || typeof parsed !== 'object') return base;

    let teaching;
    const rawClasses = parsed.teaching ? toArray(parsed.teaching.classes) : [];
    if (rawClasses.length > 0) {
      const normalizedClasses = rawClasses.map(c => ({
        id: c.id || uid('cls'),
        name: c.name || '未命名班級',
        weeks: Math.max(1, parseInt(c.weeks, 10) || 6),
        periods: Math.max(1, parseInt(c.periods, 10) || 4),
        pinnedSlot: c.pinnedSlot || null,
        items: toArray(c.items).map(item => ({
          id: item.id || uid('plan'),
          name: item.name || '',
          type: item.type || '',
          color: item.color || '#DDE6D5',
          desc: item.desc || '',
          completed: !!item.completed,
          completedAt: item.completedAt || null,
          location: item.location || { type: 'staging' }
        }))
      }));
      const activeId = normalizedClasses.some(c => c.id === parsed.teaching.activeClassId)
        ? parsed.teaching.activeClassId
        : normalizedClasses[0].id;
      teaching = { activeClassId: activeId, classes: normalizedClasses };
    } else if (parsed.teaching && toArray(parsed.teaching.items).length > 0) {
      const migratedClass = createDefaultClass(
        '英文 A 班',
        parsed.teaching.weeks || 6,
        parsed.teaching.periods || 4
      );
      migratedClass.items = toArray(parsed.teaching.items).map(item => ({
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
      avatar: (parsed.secretary && parsed.secretary.avatar) || '',
      apiKey: (parsed.secretary && parsed.secretary.apiKey) || '',
      model: (parsed.secretary && parsed.secretary.model) || 'gemini-2.5-flash',
      persona: (parsed.secretary && parsed.secretary.persona) || DEFAULT_SECRETARY_PERSONA,
      lastBriefingText: (parsed.secretary && parsed.secretary.lastBriefingText) || '',
      lastBriefingHash: (parsed.secretary && parsed.secretary.lastBriefingHash) || ''
    };

    const rawSources = toArray(parsed.sources);
    const sources = rawSources.length ? rawSources : base.sources;
    const todos = toArray(parsed.todos).map(t => ({
      id: t.id || uid('todo'),
      date: t.date || getTodayStr(),
      title: t.title || '',
      sourceId: t.sourceId || sources[0].id,
      content: t.content || '',
      note: t.note || '',
      status: t.status || 'not_started',
      todayDoneDate: t.todayDoneDate || null,
      lastWorkedDate: t.lastWorkedDate || null,
      completedAt: t.completedAt || null
    }));

    const events = toArray(parsed.events).map(e => ({
      id: e.id || uid('evt'),
      name: e.name || '',
      date: e.date || getTodayStr(),
      remindDate: e.remindDate || e.date || getTodayStr(),
      time: e.time || '',
      location: e.location || '',
      note: e.note || '',
      archived: !!e.archived,
      archivedAt: e.archivedAt || null,
      snoozeUntil: e.snoozeUntil || null
    }));

    return { secretary, teaching, sources, todos, events };
  }

  function normalizeDailyStates(targetState) {
    const today = getTodayStr();
    let changed = false;
    targetState.todos.forEach(todo => {
      if (todo.status === 'today_done') {
        if (!todo.todayDoneDate) {
          todo.todayDoneDate = today;
          changed = true;
        } else if (todo.todayDoneDate < today) {
          todo.lastWorkedDate = todo.todayDoneDate;
          todo.status = 'not_started';
          todo.todayDoneDate = null;
          changed = true;
        }
      }
    });
    targetState.events.forEach(evt => {
      if (evt.snoozeUntil && today >= evt.snoozeUntil) {
        evt.snoozeUntil = null;
        changed = true;
      }
    });
    return changed;
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();
      const loaded = migrateAndNormalizeState(JSON.parse(raw));
      normalizeDailyStates(loaded);
      return loaded;
    } catch {
      return createDefaultState();
    }
  }

  let state = loadLocalState();

  // ==================== Firebase Auth 與即時同步 ====================
  function pushToCloud() {
    if (!isCloudConnected || !dbRef) return;
    setSyncStatus('syncing', '↻ 同步中...');
    localSyncSeq += 1;
    const payload = JSON.parse(JSON.stringify(state));
    payload._syncClient = CLIENT_ID;
    payload._syncSeq = localSyncSeq;

    dbRef.set(payload)
      .then(() => {
        setSyncStatus('synced', '☁️ 雲端已同步');
      })
      .catch((err) => {
        console.error('Firebase 寫入失敗:', err);
        setSyncStatus('error', '⚠️ 權限或連線錯誤');
        showToast('寫入雲端失敗，請確認 Database 規則是否已允許你的 Gmail');
      });
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast('本機快取空間已滿，建議縮小秘書圖像檔案');
    }

    if (isCloudConnected && dbRef) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(pushToCloud, 180);
    }
  }

  function startCloudSync() {
    if (dbRef) dbRef.off();
    dbRef = firebase.database().ref(FIREBASE_PATH);
    isCloudConnected = true;
    setSyncStatus('syncing', '連線雲端中...');

    dbRef.on(
      'value',
      (snapshot) => {
        const cloudData = snapshot.val();
        if (!cloudData) {
          pushToCloud();
          return;
        }

        // 若是本分頁自己剛推上去的回彈資料，直接更新狀態燈號，不重繪畫面打斷輸入
        if (cloudData._syncClient === CLIENT_ID && cloudData._syncSeq <= localSyncSeq) {
          setSyncStatus('synced', '☁️ 雲端已同步');
          return;
        }

        state = migrateAndNormalizeState(cloudData);
        const dailyChanged = normalizeDailyStates(state);

        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {}

        renderAll();
        setSyncStatus('synced', '☁️ 雲端已同步');
        if (dailyChanged) pushToCloud();
      },
      (err) => {
        console.error('Firebase 讀取錯誤:', err);
        setSyncStatus('error', '⚠️ 雲端權限不足');
        showToast('讀取雲端失敗：請確認 Database 規則中的 Email 與登入帳號一致');
      }
    );
  }

  function stopCloudSync() {
    if (dbRef) {
      dbRef.off();
      dbRef = null;
    }
    isCloudConnected = false;
  }

  function initFirebaseAuth() {
    if (typeof firebase === 'undefined') {
      showAuthError('Firebase SDK 載入失敗，請確認網路連線。');
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    const auth = firebase.auth();
    const provider = new firebase.auth.GoogleAuthProvider();
    const authGate = document.getElementById('authGate');
    const userControls = document.getElementById('userControls');
    const userEmailDisplay = document.getElementById('userEmailDisplay');

    on('googleLoginBtn', 'click', () => {
      showAuthError('');
      auth.signInWithPopup(provider).catch((err) => {
        console.error('Google 登入錯誤:', err);
        if (err.code === 'auth/unauthorized-domain') {
          showAuthError('此網址尚未加入授權網域，請到 Firebase Console → Authentication → Settings → Authorized domains 新增目前網址。');
        } else if (err.code === 'auth/operation-not-supported-in-this-environment') {
          showAuthError('請透過 VS Code 的 Live Server（或 GitHub Pages）開啟，不能直接雙擊 HTML 檔案進行 Google 登入。');
        } else if (err.code !== 'auth/popup-closed-by-user') {
          showAuthError(`登入失敗：${err.message}`);
        }
      });
    });

    on('logoutBtn', 'click', () => {
      if (!confirm('確定要登出嗎？')) return;
      stopCloudSync();
      auth.signOut();
    });

    auth.onAuthStateChanged((user) => {
      if (!user) {
        stopCloudSync();
        if (authGate) authGate.classList.remove('hidden');
        if (userControls) userControls.classList.add('hidden');
        setSyncStatus('local', '等待登入');
        return;
      }

      const activeWhitelist = ALLOWED_EMAILS
        .map(e => e.trim().toLowerCase())
        .filter(e => e && !e.includes('你的gmail'));

      const userEmail = (user.email || '').toLowerCase();
      if (activeWhitelist.length > 0 && !activeWhitelist.includes(userEmail)) {
        auth.signOut();
        showAuthError(`帳號 ${user.email} 不在授權清單內，請改用授權的 Google 帳號登入。`);
        return;
      }

      showAuthError('');
      if (authGate) authGate.classList.add('hidden');
      if (userControls) userControls.classList.remove('hidden');
      if (userEmailDisplay) {
        userEmailDisplay.textContent = user.email;
        userEmailDisplay.title = user.email;
      }

      renderAll();
      startCloudSync();
    });
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
    const todayEl = document.getElementById('todayDateDisplay');
    if (todayEl) {
      todayEl.textContent =
        `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日（週${weekdays[today.getDay()]}）`;
    }

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('[data-jump-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.jumpTab));
    });

    on('exportDataBtn', 'click', () => {
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
    on('importDataBtn', 'click', () => fileInput && fileInput.click());
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const imported = JSON.parse(reader.result);
            if (!imported.teaching || !imported.sources) throw new Error('格式不符');
            state = migrateAndNormalizeState(imported);
            normalizeDailyStates(state);
            saveState();
            renderAll();
            showToast('資料已成功還原並同步');
          } catch {
            alert('匯入失敗：請確認檔案為本系統匯出的 JSON 備份檔。');
          }
        };
        reader.readAsText(file);
        fileInput.value = '';
      });
    }

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
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
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

  // ==================== 首頁：RPG 個人秘書、頭像裁切、AI 簡報、整合條列與歷史 ====================
  function initBriefing() {
    document.querySelectorAll('[data-briefing-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentBriefingView = btn.dataset.briefingView;
        updateBriefingViewUI();
        renderBriefingHistory();
      });
    });

    ['briefingHistoryFilterType', 'briefingHistorySearch'].forEach(id => {
      on(id, 'input', renderBriefingHistory);
    });

    // ---------- 頭像等比例裁切與縮放 ----------
    const portraitBox = document.getElementById('rpgPortraitBox');
    const avatarInput = document.getElementById('rpgAvatarInput');
    const cropCanvas = document.getElementById('avatarCropCanvas');
    const zoomSlider = document.getElementById('avatarZoomSlider');
    const zoomValue = document.getElementById('avatarZoomValue');

    const CROP_W = cropCanvas ? cropCanvas.width : 304;
    const CROP_H = cropCanvas ? cropCanvas.height : 372;
    const cropCtx = cropCanvas ? cropCanvas.getContext('2d') : null;

    const cropState = {
      img: null,
      mime: 'image/jpeg',
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      dragging: false,
      lastX: 0,
      lastY: 0
    };

    function drawCropCanvas() {
      if (!cropCtx || !cropState.img) return;
      const { img, zoom } = cropState;
      const baseScale = Math.max(CROP_W / img.width, CROP_H / img.height);
      const scale = baseScale * zoom;
      const drawW = img.width * scale;
      const drawH = img.height * scale;

      const maxOffsetX = Math.max(0, (drawW - CROP_W) / 2);
      const maxOffsetY = Math.max(0, (drawH - CROP_H) / 2);
      cropState.offsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, cropState.offsetX));
      cropState.offsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, cropState.offsetY));

      const drawX = (CROP_W - drawW) / 2 + cropState.offsetX;
      const drawY = (CROP_H - drawH) / 2 + cropState.offsetY;

      cropCtx.clearRect(0, 0, CROP_W, CROP_H);
      if (cropState.mime !== 'image/png') {
        cropCtx.fillStyle = '#F3EFE7';
        cropCtx.fillRect(0, 0, CROP_W, CROP_H);
      }
      cropCtx.imageSmoothingEnabled = true;
      cropCtx.imageSmoothingQuality = 'high';
      cropCtx.drawImage(img, drawX, drawY, drawW, drawH);
    }

    function setCropZoom(nextZoom) {
      const clamped = Math.min(3.5, Math.max(1, nextZoom));
      const ratio = clamped / cropState.zoom;
      cropState.zoom = clamped;
      cropState.offsetX *= ratio;
      cropState.offsetY *= ratio;
      if (zoomSlider) zoomSlider.value = clamped.toFixed(2);
      if (zoomValue) zoomValue.textContent = `${Math.round(clamped * 100)}%`;
      drawCropCanvas();
    }

    function resetCropView() {
      cropState.zoom = 1;
      cropState.offsetX = 0;
      cropState.offsetY = 0;
      if (zoomSlider) zoomSlider.value = '1';
      if (zoomValue) zoomValue.textContent = '100%';
      drawCropCanvas();
    }

    if (portraitBox && avatarInput) {
      portraitBox.addEventListener('click', () => avatarInput.click());
      avatarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            if (cropCanvas) {
              cropState.img = img;
              cropState.mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
              resetCropView();
              openModal('avatarCropModal');
            } else {
              // 若 index.html 尚未加入裁切視窗，自動置中裁切
              const c = document.createElement('canvas');
              c.width = 304;
              c.height = 372;
              const ctx = c.getContext('2d');
              const s = Math.max(c.width / img.width, c.height / img.height);
              const w = img.width * s;
              const h = img.height * s;
              ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
              state.secretary.avatar = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88);
              saveState();
              renderSecretaryBox();
              showToast('已更新個人秘書頭像');
            }
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
        avatarInput.value = '';
      });
    }

    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => setCropZoom(parseFloat(e.target.value)));
    }

    if (cropCanvas) {
      cropCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        setCropZoom(cropState.zoom + (e.deltaY < 0 ? 0.12 : -0.12));
      }, { passive: false });

      cropCanvas.addEventListener('pointerdown', (e) => {
        cropState.dragging = true;
        cropState.lastX = e.clientX;
        cropState.lastY = e.clientY;
        cropCanvas.setPointerCapture(e.pointerId);
      });

      cropCanvas.addEventListener('pointermove', (e) => {
        if (!cropState.dragging) return;
        const cssToCanvas = CROP_W / (cropCanvas.clientWidth || 228);
        cropState.offsetX += (e.clientX - cropState.lastX) * cssToCanvas;
        cropState.offsetY += (e.clientY - cropState.lastY) * cssToCanvas;
        cropState.lastX = e.clientX;
        cropState.lastY = e.clientY;
        drawCropCanvas();
      });

      const stopCropDrag = () => { cropState.dragging = false; };
      cropCanvas.addEventListener('pointerup', stopCropDrag);
      cropCanvas.addEventListener('pointercancel', stopCropDrag);
    }

    on('avatarResetCropBtn', 'click', resetCropView);

    on('avatarApplyCropBtn', 'click', () => {
      if (!cropState.img || !cropCanvas) return;
      drawCropCanvas();
      state.secretary.avatar = cropCanvas.toDataURL(cropState.mime, 0.88);
      saveState();
      renderSecretaryBox();
      closeModal('avatarCropModal');
      showToast('已裁切並更新個人秘書頭像');
    });

    // ---------- AI 秘書設定與重新彙報 ----------
    function openSecretarySettingsModal() {
      if (!document.getElementById('secretarySettingsModal')) {
        const nextName = prompt('請輸入個人秘書的名稱或稱呼：', state.secretary.name);
        if (nextName && nextName.trim()) {
          state.secretary.name = nextName.trim();
          saveState();
          renderSecretaryBox();
        }
        return;
      }
      document.getElementById('secNameInput').value = state.secretary.name || '傑森的線上秘書';
      document.getElementById('secApiKeyInput').value = state.secretary.apiKey || '';
      document.getElementById('secApiKeyInput').type = 'password';
      document.getElementById('toggleApiKeyVisBtn').textContent = '顯示';
      document.getElementById('secModelSelect').value = state.secretary.model || 'gemini-2.5-flash';
      document.getElementById('secPersonaInput').value = state.secretary.persona || DEFAULT_SECRETARY_PERSONA;
      openModal('secretarySettingsModal');
    }

    on('rpgEditNameBtn', 'click', openSecretarySettingsModal);
    on('rpgOpenSettingsBtn', 'click', openSecretarySettingsModal);

    on('toggleApiKeyVisBtn', 'click', (e) => {
      const input = document.getElementById('secApiKeyInput');
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      e.target.textContent = isPwd ? '隱藏' : '顯示';
    });

    on('secResetPersonaBtn', 'click', () => {
      const el = document.getElementById('secPersonaInput');
      if (el) el.value = DEFAULT_SECRETARY_PERSONA;
    });

    on('saveSecretarySettingsBtn', 'click', () => {
      const name = document.getElementById('secNameInput').value.trim() || '傑森的線上秘書';
      const apiKey = document.getElementById('secApiKeyInput').value.trim();
      const model = document.getElementById('secModelSelect').value || 'gemini-2.5-flash';
      const persona = document.getElementById('secPersonaInput').value.trim() || DEFAULT_SECRETARY_PERSONA;

      state.secretary.name = name;
      state.secretary.apiKey = apiKey;
      state.secretary.model = model;
      state.secretary.persona = persona;
      state.secretary.lastBriefingHash = '';
      lastFailedBriefingHash = '';

      saveState();
      closeModal('secretarySettingsModal');
      showToast('已儲存 AI 秘書設定');

      if (latestBriefingPayload) {
        if (apiKey) {
          generateAiBriefing(latestBriefingPayload, true);
        } else {
          renderSecretaryBox(latestBriefingPayload);
        }
      }
    });

    on('rpgRefreshAiBtn', 'click', () => {
      if (!state.secretary.apiKey) {
        showToast('請先填入免費的 Gemini API Key 以啟用 AI 簡報');
        openSecretarySettingsModal();
        return;
      }
      if (latestBriefingPayload) {
        lastFailedBriefingHash = '';
        generateAiBriefing(latestBriefingPayload, true);
      }
    });

    on('rpgResetAvatarBtn', 'click', () => {
      if (!confirm('確定要移除目前的秘書圖像嗎？')) return;
      state.secretary.avatar = '';
      saveState();
      renderSecretaryBox();
      showToast('已移除秘書圖像');
    });

    // ---------- 待辦處理詢問視窗 ----------
    on('resolveTodayDoneBtn', 'click', () => {
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

    on('resolveCompleteBtn', 'click', () => {
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

    // ---------- 非當天活動提醒處理視窗 ----------
    on('resolveEventUntilDayBtn', 'click', () => {
      const id = document.getElementById('resolveEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      evt.snoozeUntil = evt.date;
      saveState();
      closeModal('eventResolveModal');
      renderAll();
      showToast(`「${evt.name}」至活動前一天不再提醒，將於 ${evt.date} 當天恢復顯示`);
    });

    on('resolveEventDayBeforeBtn', 'click', () => {
      const id = document.getElementById('resolveEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      const dayBefore = addDays(evt.date, -1);
      evt.snoozeUntil = dayBefore;
      saveState();
      closeModal('eventResolveModal');
      renderAll();
      showToast(`「${evt.name}」已暫停提醒，將於活動前一天（${dayBefore}）恢復顯示`);
    });

    on('resolveEventCustomBtn', 'click', () => {
      const id = document.getElementById('resolveEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      const picked = document.getElementById('resolveEventCustomDate').value;
      const today = getTodayStr();
      if (!picked || picked <= today) {
        return showToast('請選擇明天之後的日期');
      }
      evt.snoozeUntil = picked;
      saveState();
      closeModal('eventResolveModal');
      renderAll();
      showToast(`「${evt.name}」於 ${picked} 前不再提醒，將於該日恢復顯示`);
    });

    on('resolveEventKeepBtn', 'click', () => {
      const id = document.getElementById('resolveEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      const tomorrow = addDays(getTodayStr(), 1);
      evt.snoozeUntil = tomorrow;
      saveState();
      closeModal('eventResolveModal');
      renderAll();
      showToast(`「${evt.name}」今日不再提醒，明日（${tomorrow}）起將持續提醒`);
    });

    on('resolveEventArchiveBtn', 'click', () => {
      const id = document.getElementById('resolveEventId').value;
      const evt = state.events.find(e => e.id === id);
      if (!evt) return;
      evt.archived = true;
      evt.archivedAt = getTodayStr();
      evt.snoozeUntil = null;
      saveState();
      closeModal('eventResolveModal');
      renderAll();
      showToast(`活動「${evt.name}」已撤除並納入歷史備查`);
    });
  }

  function updateBriefingViewUI() {
    document.querySelectorAll('[data-briefing-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.briefingView === currentBriefingView);
    });
    const isHistory = currentBriefingView === 'history';
    document.getElementById('briefingTodayWrap').classList.toggle('hidden', isHistory);
    document.getElementById('briefingHistoryWrap').classList.toggle('hidden', !isHistory);
    document.getElementById('briefingHistoryFilters').classList.toggle('hidden', !isHistory);
    document.getElementById('briefingSubHint').textContent = isHistory
      ? '彙整三大平台所有已完成教學事項、結案待辦與已結束／歸檔活動，可隨時建立副本重複使用'
      : '條列整合三大平台重點：勾選即同步更新狀態（待辦事項與非當天活動將進一步確認處理方式）';
  }

  function openTodoResolveModal(todo) {
    document.getElementById('resolveTodoId').value = todo.id;
    document.getElementById('resolveTodoTitleDisplay').textContent = todo.title;
    openModal('todoResolveModal');
  }

  function openEventResolveModal(evt) {
    const modal = document.getElementById('eventResolveModal');
    if (!modal) {
      alert('找不到活動提醒設定視窗（eventResolveModal），請確認 index.html 已貼上 Modal 7。');
      return;
    }

    const today = getTodayStr();
    const tomorrow = addDays(today, 1);
    const dayBefore = addDays(evt.date, -1);
    const daysLeft = diffDays(today, evt.date);

    document.getElementById('resolveEventId').value = evt.id;
    document.getElementById('resolveEventTitleDisplay').textContent = evt.name;
    document.getElementById('resolveEventDateDisplay').textContent = evt.date;
    document.getElementById('resolveEventUntilDayDate').textContent = evt.date;

    const dayBeforeBtn = document.getElementById('resolveEventDayBeforeBtn');
    if (daysLeft >= 2) {
      document.getElementById('resolveEventDayBeforeDate').textContent = dayBefore;
      dayBeforeBtn.classList.remove('hidden');
    } else {
      dayBeforeBtn.classList.add('hidden');
    }

    const customDateInput = document.getElementById('resolveEventCustomDate');
    customDateInput.min = tomorrow;
    customDateInput.max = evt.date;
    customDateInput.value = tomorrow <= evt.date ? tomorrow : evt.date;

    openModal('eventResolveModal');
  }

  function getTimeGreeting() {
    const h = new Date().getHours();
    if (h < 12) return '早安';
    if (h < 18) return '午安';
    return '晚安';
  }

  function buildFallbackDialogue(payload) {
    const { teachingPending, eventsCount, todosCount } = payload;
    const totalPending = teachingPending + eventsCount + todosCount;
    const greeting = getTimeGreeting();
    if (totalPending === 0) {
      return `「${greeting}，Jace！今天的教學、七日內活動與待辦事項都已經清空囉。趁現在好好喝杯茶、喘口氣吧。」`;
    }
    return `「${greeting}，Jace！我已經把今天的重點都整理在下方清單裡了——目前還有 ${teachingPending} 項今日教學進度、${eventsCount} 個七日內活動，以及 ${todosCount} 件待辦事項。處理完直接打勾就可以了！」`;
  }

  async function generateAiBriefing(payload, isManual = false) {
    const apiKey = (state.secretary.apiKey || '').trim();
    if (!apiKey || isGeneratingAiBriefing) return;

    isGeneratingAiBriefing = true;
    hasAutoRefreshedOnLoad = true;
    const dialogueEl = document.getElementById('rpgDialogueText');
    const refreshBtn = document.getElementById('rpgRefreshAiBtn');
    const aiBadge = document.getElementById('rpgAiBadge');

    if (dialogueEl) {
      dialogueEl.classList.add('is-loading');
      dialogueEl.textContent = '「正在檢視各平台的最新進度與行程，請稍候一下……」';
    }
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '整理中...';
    }

    const today = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dateHeader = `${getTodayStr()}（週${weekdays[today.getDay()]}，目前時段：${getTimeGreeting()}）`;

    const promptText = [
      `你的角色稱呼：${state.secretary.name || '傑森的線上秘書'}`,
      `人設與回覆規則：${state.secretary.persona || DEFAULT_SECRETARY_PERSONA}`,
      '',
      `今天日期：${dateHeader}`,
      '',
      '【一、教學進度平台（今日與下堂課）】',
      payload.teachingSummary.length ? payload.teachingSummary.join('\n') : '（目前無排定或待教項目）',
      '',
      '【二、活動提醒平台（七日內或提醒中）】',
      payload.eventSummary.length ? payload.eventSummary.join('\n') : '（七日內無即將到來的活動）',
      '',
      '【三、待辦事項平台（進行中）】',
      payload.todoSummary.length ? payload.todoSummary.join('\n') : '（目前沒有未處理的待辦事項）',
      '',
      '請直接輸出你要對 Jace 說的話（可用「」包住，不要加上多餘前言或說明）。'
    ].join('\n');

    const model = state.secretary.model || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const generationConfig = {
        temperature: 0.75
      };
      if (model.includes('2.5')) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig
        })
      });

      const data = await res.json();
      console.log('AI 回傳狀態:', {
        model,
        finishReason: data?.candidates?.[0]?.finishReason,
        usage: data?.usageMetadata
      });
      if (!res.ok) {
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const aiText = parts
        .filter(p => !p.thought && p.text)
        .map(p => p.text)
        .join('')
        .trim();

      if (!aiText) throw new Error('模型未回傳文字內容');

      state.secretary.lastBriefingText = aiText;
      state.secretary.lastBriefingHash = payload.hash;
      lastFailedBriefingHash = '';
      saveState();

      if (dialogueEl) {
        dialogueEl.classList.remove('is-loading');
        dialogueEl.textContent = aiText;
      }
      if (aiBadge) aiBadge.classList.remove('hidden');
      if (isManual) showToast('AI 秘書已完成最新彙報');
    } catch (err) {
      console.error('Gemini API 呼叫失敗:', err);
      lastFailedBriefingHash = payload.hash;
      if (dialogueEl) {
        dialogueEl.classList.remove('is-loading');
        dialogueEl.textContent = state.secretary.lastBriefingText || buildFallbackDialogue(payload);
      }
      if (isManual) {
        showToast(`AI 彙報失敗：${err.message}`);
      }
    } finally {
      isGeneratingAiBriefing = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 重新彙報';
      }
    }
  }

  function renderSecretaryBox(payload = null) {
    const imgEl = document.getElementById('rpgPortraitImg');
    const placeholderEl = document.getElementById('rpgPortraitPlaceholder');
    const resetBtn = document.getElementById('rpgResetAvatarBtn');
    const aiBadge = document.getElementById('rpgAiBadge');

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

    if (!payload) return;
    latestBriefingPayload = payload;

    const { teachingPending, eventsCount, todosCount, hash } = payload;
    const dialogueEl = document.getElementById('rpgDialogueText');

    document.getElementById('rpgSummaryPills').innerHTML = `
      <span class="rpg-stat-pill">今日待教<strong>${teachingPending}</strong>項</span>
      <span class="rpg-stat-pill">七日內活動<strong>${eventsCount}</strong>件</span>
      <span class="rpg-stat-pill">待處理待辦<strong>${todosCount}</strong>件</span>
    `;

    const hasApiKey = !!(state.secretary.apiKey && state.secretary.apiKey.trim());
    if (aiBadge) aiBadge.classList.toggle('hidden', !hasApiKey);

    if (!hasApiKey) {
      dialogueEl.classList.remove('is-loading');
      dialogueEl.textContent = buildFallbackDialogue(payload);
      return;
    }

    const shouldForceOnLoad = !hasAutoRefreshedOnLoad;

    if (!shouldForceOnLoad && state.secretary.lastBriefingHash === hash && state.secretary.lastBriefingText) {
      dialogueEl.classList.remove('is-loading');
      dialogueEl.textContent = state.secretary.lastBriefingText;
      return;
    }

    if (!isGeneratingAiBriefing) {
      dialogueEl.textContent = state.secretary.lastBriefingText || buildFallbackDialogue(payload);
      if (shouldForceOnLoad || lastFailedBriefingHash !== hash) {
        clearTimeout(aiAutoTimer);
        aiAutoTimer = setTimeout(() => {
          if (
            latestBriefingPayload &&
            (!hasAutoRefreshedOnLoad || state.secretary.lastBriefingHash !== latestBriefingPayload.hash)
          ) {
            hasAutoRefreshedOnLoad = true;
            generateAiBriefing(latestBriefingPayload, false);
          }
        }, 1000);
      }
    }
  }

  function renderBriefingHistory() {
    const today = getTodayStr();
    const filterType = document.getElementById('briefingHistoryFilterType').value;
    const keyword = document.getElementById('briefingHistorySearch').value.trim().toLowerCase();

    const records = [];

    state.teaching.classes.forEach(cls => {
      cls.items
        .filter(item => item.completed)
        .forEach(item => {
          const locText = item.location.type === 'cell'
            ? `${cls.name}・W${item.location.week}-第${item.location.period}節`
            : `${cls.name}・待排區`;
          records.push({
            platform: 'teaching',
            sortDate: item.completedAt || '0000-00-00',
            dateLabel: item.completedAt ? `完成於 ${item.completedAt}` : '已完成',
            searchText: `${cls.name} ${item.name} ${item.type || ''} ${item.desc || ''}`.toLowerCase(),
            cls,
            item,
            locText
          });
        });
    });

    state.todos
      .filter(t => t.status === 'completed')
      .forEach(todo => {
        const src = getSourceById(todo.sourceId);
        records.push({
          platform: 'todo',
          sortDate: todo.completedAt || todo.date || '0000-00-00',
          dateLabel: `建立：${todo.date}｜完成：${todo.completedAt || '-'}`,
          searchText: `${src.name} ${todo.title} ${todo.content || ''} ${todo.note || ''}`.toLowerCase(),
          todo,
          src
        });
      });

    state.events
      .filter(e => e.archived || e.date < today)
      .forEach(evt => {
        records.push({
          platform: 'event',
          sortDate: evt.archivedAt || evt.date || '0000-00-00',
          dateLabel: evt.archived
            ? `活動日：${evt.date}｜已處理歸檔${evt.archivedAt ? `（${evt.archivedAt}）` : ''}`
            : `活動日：${evt.date}｜已結束`,
          searchText: `${evt.name} ${evt.location || ''} ${evt.time || ''} ${evt.note || ''}`.toLowerCase(),
          evt
        });
      });

    records.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
    document.getElementById('briefingHistoryCount').textContent = records.length;

    const filtered = records.filter(rec => {
      if (filterType !== 'all' && rec.platform !== filterType) return false;
      if (keyword && !rec.searchText.includes(keyword)) return false;
      return true;
    });

    const listEl = document.getElementById('briefingHistoryList');
    listEl.innerHTML = '';

    if (filtered.length === 0) {
      listEl.innerHTML = '<li class="empty-state">目前沒有符合條件的綜合歷史紀錄。</li>';
      return;
    }

    filtered.forEach(rec => {
      const li = document.createElement('li');
      li.className = 'unified-row is-history-row';

      if (rec.platform === 'teaching') {
        const { cls, item, locText } = rec;
        li.innerHTML = `
          <div class="unified-body">
            <div class="unified-main-line">
              <span class="origin-tag origin-teaching">來自 教學進度平台</span>
              <span class="origin-slash">/</span>
              <span class="unified-sub-pill">${escapeHtml(locText)}</span>
              <span class="unified-content-title">
                <span class="color-dot" style="background:${item.color}"></span>
                ${escapeHtml(item.name)}${item.type ? `（${escapeHtml(item.type)}）` : ''}
              </span>
              <span class="date-tag">${escapeHtml(rec.dateLabel)}</span>
            </div>
            ${item.desc ? `<div class="unified-sub-line">備註：${escapeHtml(item.desc)}</div>` : ''}
          </div>
          <div class="history-row-actions">
            <button type="button" class="text-btn" data-copy-plan>建立副本</button>
            <button type="button" class="text-btn" data-restore-plan>恢復未完成</button>
          </div>
        `;
        li.querySelector('[data-copy-plan]').addEventListener('click', () => {
          duplicateTeachingItemToStaging(cls, item);
        });
        li.querySelector('[data-restore-plan]').addEventListener('click', () => {
          item.completed = false;
          item.completedAt = null;
          saveState();
          renderTeaching();
          renderBriefing();
          showToast(`已恢復「${item.name}」為未完成`);
        });
      } else if (rec.platform === 'todo') {
        const { todo, src } = rec;
        li.style.borderLeft = `4px solid ${src.color}`;
        const subParts = [
          todo.content ? todo.content : '',
          todo.note ? `備註：${todo.note}` : ''
        ].filter(Boolean);

        li.innerHTML = `
          <div class="unified-body">
            <div class="unified-main-line">
              <span class="origin-tag origin-todo">來自 待辦事項平台</span>
              <span class="origin-slash">/</span>
              <span class="source-badge" style="background:${src.color};color:${getContrastColor(src.color)}">${escapeHtml(src.name)}</span>
              <span class="unified-content-title">${escapeHtml(todo.title)}</span>
              <span class="date-tag">${escapeHtml(rec.dateLabel)}</span>
            </div>
            ${subParts.length ? `<div class="unified-sub-line">${escapeHtml(subParts.join('｜'))}</div>` : ''}
          </div>
          <div class="history-row-actions">
            <button type="button" class="text-btn" data-copy-todo>建立副本</button>
            <button type="button" class="text-btn" data-restore-todo>復原至待辦</button>
          </div>
        `;
        li.querySelector('[data-copy-todo]').addEventListener('click', () => {
          duplicateTodoItem(todo);
        });
        li.querySelector('[data-restore-todo]').addEventListener('click', () => {
          todo.status = 'not_started';
          todo.completedAt = null;
          todo.todayDoneDate = null;
          saveState();
          renderTodos();
          renderBriefing();
          showToast(`已復原待辦「${todo.title}」`);
        });
      } else if (rec.platform === 'event') {
        const { evt } = rec;
        const canRestore = evt.archived && evt.date >= today;
        const metaParts = [
          evt.time ? `時間：${evt.time}` : '',
          evt.location ? `地點：${evt.location}` : '',
          evt.note ? `備註：${evt.note}` : ''
        ].filter(Boolean);

        li.innerHTML = `
          <div class="unified-body">
            <div class="unified-main-line">
              <span class="origin-tag origin-event">來自 活動提醒平台</span>
              <span class="origin-slash">/</span>
              <span class="unified-content-title">${escapeHtml(evt.name)}</span>
              <span class="date-tag">${escapeHtml(rec.dateLabel)}</span>
            </div>
            ${metaParts.length ? `<div class="unified-sub-line">${escapeHtml(metaParts.join('｜'))}</div>` : ''}
          </div>
          <div class="history-row-actions">
            <button type="button" class="text-btn" data-copy-evt>建立副本</button>
            ${canRestore ? '<button type="button" class="text-btn" data-restore-evt>復原活動</button>' : ''}
          </div>
        `;
        li.querySelector('[data-copy-evt]').addEventListener('click', () => {
          duplicateEventItem(evt);
        });
        const restoreBtn = li.querySelector('[data-restore-evt]');
        if (restoreBtn) {
          restoreBtn.addEventListener('click', () => {
            evt.archived = false;
            evt.archivedAt = null;
            evt.snoozeUntil = null;
            saveState();
            renderEvents();
            renderBriefing();
            showToast(`已復原活動「${evt.name}」`);
          });
        }
      }

      listEl.appendChild(li);
    });
  }

  function renderBriefing() {
    updateBriefingViewUI();
    const today = getTodayStr();
    const listEl = document.getElementById('briefingUnifiedList');
    listEl.innerHTML = '';

    let teachingPending = 0;
    let rowCount = 0;

    // 1. 教學進度（各班今日進度 + 下堂課進度）
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

    // 2. 七日內或已到提醒日的活動（排除暫停提醒尚未到期者）
    const activeWindowEvents = state.events.filter(
      e => !e.archived && e.date >= today && (diffDays(today, e.date) <= 7 || today >= e.remindDate)
    );

    const upcoming7Days = activeWindowEvents
      .filter(e => !e.snoozeUntil || today >= e.snoozeUntil)
      .sort((a, b) => a.date.localeCompare(b.date));

    const hiddenSnoozedEventsCount = activeWindowEvents.filter(
      e => e.snoozeUntil && today < e.snoozeUntil
    ).length;

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
        if (evt.date > today) {
          e.target.checked = false;
          openEventResolveModal(evt);
          return;
        }
        evt.archived = true;
        evt.archivedAt = getTodayStr();
        evt.snoozeUntil = null;
        saveState();
        renderEvents();
        renderBriefing();
        showToast(`活動「${evt.name}」已撤除並納入歷史備查`);
      });

      listEl.appendChild(li);
    });

    // 3. 待辦事項（全列，排除今日已標記「今日進度已完成」者）
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

    document.getElementById('briefingTodayCount').textContent = rowCount;

    if (rowCount === 0) {
      listEl.innerHTML = '<li class="empty-state">目前沒有待處理的重點事項。可點選上方分頁新增教學進度、待辦或活動提醒。</li>';
    }

    const footnote = document.getElementById('briefingTodoHiddenHint');
    const hiddenNotes = [];
    if (hiddenTodayDoneCount > 0) {
      hiddenNotes.push(`今日已有 ${hiddenTodayDoneCount} 件待辦標記「今日進度已完成」（將於明日自動恢復）`);
    }
    if (hiddenSnoozedEventsCount > 0) {
      hiddenNotes.push(`另有 ${hiddenSnoozedEventsCount} 個活動已暫停首頁提醒（可至「活動提醒平台」檢視或提前恢復）`);
    }
    if (hiddenNotes.length > 0) {
      footnote.textContent = `※ ${hiddenNotes.join('；')}。`;
      footnote.classList.remove('hidden');
    } else {
      footnote.classList.add('hidden');
    }

    // 組裝三大平台摘要供 AI 秘書檢視
    const teachingSummary = [];
    state.teaching.classes.forEach(cls => {
      const { todaySlot, nextSlot } = getClassLessonBriefing(cls);
      if (todaySlot && todaySlot.items.length > 0) {
        todaySlot.items.forEach(item => {
          teachingSummary.push(
            `[今日・${cls.name} W${todaySlot.week}-第${todaySlot.period}節] ${item.completed ? '(已完成)' : '(待教)'} ${item.name}${item.type ? `(${item.type})` : ''}${item.desc ? ` - 備註:${item.desc}` : ''}`
          );
        });
      }
      if (nextSlot && nextSlot.items.length > 0) {
        nextSlot.items.forEach(item => {
          teachingSummary.push(
            `[下堂課・${cls.name} W${nextSlot.week}-第${nextSlot.period}節] ${item.name}${item.type ? `(${item.type})` : ''}`
          );
        });
      }
    });

    const eventSummary = upcoming7Days.map(evt => {
      const daysLeft = diffDays(today, evt.date);
      const dayText = daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft}天後`;
      return `[${dayText}・${evt.date}] ${evt.name}${evt.time ? ` 時間:${evt.time}` : ''}${evt.location ? ` 地點:${evt.location}` : ''}${evt.note ? ` 備註:${evt.note}` : ''}`;
    });

    const todoSummary = visibleTodos.map(todo => {
      const src = getSourceById(todo.sourceId);
      return `[${src.name}] ${todo.title}${todo.content ? `：${todo.content}` : ''}${todo.note ? `（備註：${todo.note}）` : ''}`;
    });

    const briefingHash = JSON.stringify({
      d: today,
      g: getTimeGreeting(),
      n: state.secretary.name,
      p: state.secretary.persona,
      t: teachingSummary,
      e: eventSummary,
      o: todoSummary
    });

    renderSecretaryBox({
      teachingPending,
      eventsCount: upcoming7Days.length,
      todosCount: visibleTodos.length,
      teachingSummary,
      eventSummary,
      todoSummary,
      hash: briefingHash
    });
    renderBriefingHistory();
  }

  // ==================== 第一部分：教學進度平台（多班級、編輯、複製、多選批次複製） ====================
  function setMultiSelectMode(enabled) {
    isMultiSelectMode = enabled;
    if (!enabled) selectedPlanIds.clear();
    renderTeaching();
  }

  function duplicatePlanItems(itemIds, targetClassId = null) {
    const sourceCls = getActiveClass();
    const targetCls = state.teaching.classes.find(c => c.id === targetClassId) || sourceCls;
    const idSet = new Set(itemIds);
    const itemsToCopy = sourceCls.items.filter(item => idSet.has(item.id));

    if (itemsToCopy.length === 0) {
      showToast('請先選取至少一個要複製的項目');
      return;
    }

    itemsToCopy.forEach(item => {
      targetCls.items.push({
        id: uid('plan'),
        name: item.name,
        type: item.type || '',
        color: item.color || '#DDE6D5',
        desc: item.desc || '',
        completed: false,
        completedAt: null,
        location: { type: 'staging' }
      });
    });

    saveState();
    renderTeaching();
    renderBriefing();

    if (itemsToCopy.length === 1) {
      showToast(`已複製「${itemsToCopy[0].name}」至「${targetCls.name}」待排區`);
    } else {
      showToast(`已一次複製 ${itemsToCopy.length} 個項目至「${targetCls.name}」待排區`);
    }
  }

  function initTeaching() {
    on('toggleMultiSelectBtn', 'click', () => setMultiSelectMode(!isMultiSelectMode));
    on('stagingMultiBtn', 'click', () => setMultiSelectMode(!isMultiSelectMode));
    on('exitMultiSelectBtn', 'click', () => setMultiSelectMode(false));

    on('batchSelectAllStagingBtn', 'click', () => {
      const cls = getActiveClass();
      cls.items
        .filter(i => i.location.type === 'staging')
        .forEach(i => selectedPlanIds.add(i.id));
      renderTeaching();
    });

    on('batchClearSelectionBtn', 'click', () => {
      selectedPlanIds.clear();
      renderTeaching();
    });

    on('batchDuplicateBtn', 'click', () => {
      const targetClassId = document.getElementById('batchTargetClassSelect').value;
      const ids = Array.from(selectedPlanIds);
      if (ids.length === 0) return showToast('請先點擊項目進行選取');
      duplicatePlanItems(ids, targetClassId);
      selectedPlanIds.clear();
      renderTeaching();
    });

    on('addClassBtn', 'click', () => {
      document.getElementById('classModalMode').value = 'add';
      document.getElementById('classModalTitle').textContent = '新增班級';
      document.getElementById('classNameInput').value = '';
      openModal('classModal');
      setTimeout(() => document.getElementById('classNameInput').focus(), 50);
    });

    on('renameClassBtn', 'click', () => {
      const cls = getActiveClass();
      document.getElementById('classModalMode').value = 'rename';
      document.getElementById('classModalTitle').textContent = '重新命名班級';
      document.getElementById('classNameInput').value = cls.name;
      openModal('classModal');
      setTimeout(() => document.getElementById('classNameInput').focus(), 50);
    });

    on('saveClassModalBtn', 'click', () => {
      const mode = document.getElementById('classModalMode').value;
      const name = document.getElementById('classNameInput').value.trim();
      if (!name) return showToast('請輸入班級名稱');

      if (mode === 'add') {
        const current = getActiveClass();
        const newCls = createDefaultClass(name, current.weeks, current.periods);
        state.teaching.classes.push(newCls);
        state.teaching.activeClassId = newCls.id;
        selectedPlanIds.clear();
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

    on('deleteClassBtn', 'click', () => {
      if (state.teaching.classes.length <= 1) {
        return showToast('至少需保留一個班級');
      }
      const cls = getActiveClass();
      if (!confirm(`確定要刪除「${cls.name}」及其所有排課資料嗎？`)) return;
      state.teaching.classes = state.teaching.classes.filter(c => c.id !== cls.id);
      state.teaching.activeClassId = state.teaching.classes[0].id;
      selectedPlanIds.clear();
      saveState();
      renderTeaching();
      renderBriefing();
      showToast(`已刪除班級「${cls.name}」`);
    });

    on('generateTableBtn', 'click', () => {
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
    if (colorInput) {
      colorInput.addEventListener('input', () => {
        document.querySelectorAll('#planColorPresets .swatch').forEach(s => s.classList.remove('active'));
      });
    }

    on('addPlanItemBtn', 'click', () => {
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

    on('savePlanEditBtn', 'click', () => {
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

    on('duplicatePlanModalBtn', 'click', () => {
      const id = document.getElementById('editPlanId').value;
      if (!id) return;
      duplicatePlanItems([id]);
      closeModal('planModal');
    });

    on('deletePlanItemBtn', 'click', () => {
      const cls = getActiveClass();
      const id = document.getElementById('editPlanId').value;
      if (!confirm('確定要刪除此教學事項嗎？')) return;
      cls.items = cls.items.filter(i => i.id !== id);
      selectedPlanIds.delete(id);
      saveState();
      renderTeaching();
      renderBriefing();
      closeModal('planModal');
      showToast('已刪除事項');
    });
  }

  function createPlanChip(item) {
    const isSelected = selectedPlanIds.has(item.id);
    const chip = document.createElement('div');
    chip.className = `plan-chip${item.completed ? ' completed' : ''}${isMultiSelectMode ? ' multi-selectable' : ''}${isSelected ? ' is-selected' : ''}`;
    chip.dataset.itemId = item.id;
    chip.style.backgroundColor = item.color;
    chip.style.color = getContrastColor(item.color);
    chip.title = isMultiSelectMode
      ? '點擊選取或取消選取此項目'
      : '拖曳或長按可移位｜點一下標記完成｜點右側圖示編輯或複製';

    chip.innerHTML = `
      ${isMultiSelectMode ? `<span class="chip-select-box">${isSelected ? '✓' : ''}</span>` : ''}
      <span class="chip-check">✓</span>
      <span class="chip-name">${escapeHtml(item.name)}</span>
      ${item.type ? `<span class="chip-type">${escapeHtml(item.type)}</span>` : ''}
      ${!isMultiSelectMode ? `
        <span class="chip-actions">
          <button type="button" class="chip-action-btn" data-chip-edit title="編輯此項目">✎</button>
          <button type="button" class="chip-action-btn" data-chip-copy title="複製此項目至待排區">❐</button>
        </span>
      ` : ''}
    `;

    const editBtn = chip.querySelector('[data-chip-edit]');
    const copyBtn = chip.querySelector('[data-chip-copy]');

    if (editBtn) {
      editBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlanEditModal(item.id);
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        duplicatePlanItems([item.id]);
      });
    }

    attachChipInteractions(chip, item.id);
    return chip;
  }

  let clickTracker = { id: null, timer: null };

  function attachChipInteractions(chip, itemId) {
    if (isMultiSelectMode) {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedPlanIds.has(itemId)) {
          selectedPlanIds.delete(itemId);
        } else {
          selectedPlanIds.add(itemId);
        }
        renderTeaching();
      });
      return;
    }

    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest('.chip-actions')) return;

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

    const validIds = new Set(cls.items.map(i => i.id));
    Array.from(selectedPlanIds).forEach(id => {
      if (!validIds.has(id)) selectedPlanIds.delete(id);
    });

    const batchBar = document.getElementById('batchActionBar');
    const toggleBtn = document.getElementById('toggleMultiSelectBtn');
    const stagingMultiBtn = document.getElementById('stagingMultiBtn');

    batchBar.classList.toggle('hidden', !isMultiSelectMode);
    toggleBtn.classList.toggle('active-toggle', isMultiSelectMode);
    stagingMultiBtn.classList.toggle('active-toggle', isMultiSelectMode);
    toggleBtn.textContent = isMultiSelectMode ? '✓ 退出多選' : '☑ 多選複製';
    stagingMultiBtn.textContent = isMultiSelectMode ? '退出多選' : '☑ 多選';
    document.getElementById('batchSelectedCount').textContent = selectedPlanIds.size;

    const targetSelect = document.getElementById('batchTargetClassSelect');
    const prevTarget = targetSelect.value;
    targetSelect.innerHTML = state.teaching.classes
      .map(c => `<option value="${c.id}">${escapeHtml(c.name)}${c.id === cls.id ? '（本班）' : ''}</option>`)
      .join('');
    targetSelect.value = state.teaching.classes.some(c => c.id === prevTarget) ? prevTarget : cls.id;

    const tabsWrap = document.getElementById('classTabsContainer');
    tabsWrap.innerHTML = '';
    state.teaching.classes.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `class-tab-btn${c.id === cls.id ? ' active' : ''}`;
      btn.textContent = c.name;
      btn.addEventListener('click', () => {
        state.teaching.activeClassId = c.id;
        selectedPlanIds.clear();
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

    on('openSourceModalBtn', 'click', () => {
      renderSourceManager();
      openModal('sourceModal');
    });

    on('addSourceBtn', 'click', () => {
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

    on('addTodoBtn', 'click', () => {
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
      on(id, 'input', renderTodos);
    });

    on('saveTodoEditBtn', 'click', () => {
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
              <button type="button" class="text-btn" data-copy="${todo.id}">建立副本</button>
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

        card.querySelector('[data-copy]').addEventListener('click', () => duplicateTodoItem(todo));
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
              <button type="button" class="text-btn" data-copy="${todo.id}">建立副本</button>
              <button type="button" class="text-btn" data-restore="${todo.id}">復原至待辦</button>
              <button type="button" class="text-btn danger" data-del="${todo.id}">永久刪除</button>
            </div>
          </div>
          ${todo.content ? `<div class="card-body">${escapeHtml(todo.content)}</div>` : ''}
          ${todo.note ? `<div class="card-note">備註：${escapeHtml(todo.note)}</div>` : ''}
        `;

        card.querySelector('[data-copy]').addEventListener('click', () => duplicateTodoItem(todo));

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
          renderBriefing();
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

    on('addEventBtn', 'click', () => {
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
        archivedAt: null,
        snoozeUntil: null
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

    on('eventSearchInput', 'input', renderEvents);

    on('saveEventEditBtn', 'click', () => {
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

      if (evt.snoozeUntil && evt.snoozeUntil > evt.date) {
        evt.snoozeUntil = null;
      }

      saveState();
      renderEvents();
      renderBriefing();
      closeModal('eventEditModal');
      showToast('已更新活動資訊');
    });
    // 小日曆切換與快速帶入日期
    on('calPrevBtn', 'click', () => {
      calMonth -= 1;
      if (calMonth < 0) {
        calMonth = 11;
        calYear -= 1;
      }
      renderEventCalendar();
    });

    on('calNextBtn', 'click', () => {
      calMonth += 1;
      if (calMonth > 11) {
        calMonth = 0;
        calYear += 1;
      }
      renderEventCalendar();
    });

    on('calTodayBtn', 'click', () => {
      const now = new Date();
      calYear = now.getFullYear();
      calMonth = now.getMonth();
      calSelectedDate = getTodayStr();
      renderEventCalendar();
    });

    on('calQuickAddBtn', 'click', () => {
      document.getElementById('eventDate').value = calSelectedDate;
      document.getElementById('eventRemindDate').value = calSelectedDate;
      document.getElementById('eventName').focus();
      showToast(`已將 ${calSelectedDate} 帶入新增表單`);
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

    const hasActiveReminder = upcomingAll.some(
      e => (!e.snoozeUntil || today >= e.snoozeUntil) && today >= e.remindDate && today <= e.date
    );
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
        const isSnoozed = !isPast && evt.snoozeUntil && today < evt.snoozeUntil;
        const isReminding = !isPast && !isSnoozed && today >= evt.remindDate;

        let badgeHtml = '';
        if (isPast) {
          badgeHtml = evt.archived
            ? `<span class="event-badge past">已處理歸檔${evt.archivedAt ? `（${escapeHtml(evt.archivedAt)}）` : ''}</span>`
            : '<span class="event-badge past">已結束</span>';
        } else if (daysLeft === 0) {
          badgeHtml = '<span class="event-badge alert">就是今天</span>';
        } else if (isSnoozed) {
          badgeHtml = `<span class="event-badge snoozed">首頁暫停至 ${escapeHtml(evt.snoozeUntil)}</span>`;
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
              ${isSnoozed ? `<button type="button" class="text-btn" data-unsnooze="${evt.id}">恢復首頁提醒</button>` : ''}
              <button type="button" class="text-btn" data-copy="${evt.id}">建立副本</button>
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

        const unsnoozeBtn = card.querySelector('[data-unsnooze]');
        if (unsnoozeBtn) {
          unsnoozeBtn.addEventListener('click', () => {
            evt.snoozeUntil = null;
            saveState();
            renderEvents();
            renderBriefing();
            showToast(`已恢復「${evt.name}」於 Today's Briefing 顯示`);
          });
        }

        card.querySelector('[data-copy]').addEventListener('click', () => duplicateEventItem(evt));

        const archiveBtn = card.querySelector('[data-archive]');
        if (archiveBtn) {
          archiveBtn.addEventListener('click', () => {
            evt.archived = true;
            evt.archivedAt = getTodayStr();
            evt.snoozeUntil = null;
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
            evt.snoozeUntil = null;
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
    renderEventCalendar();
  }

  function renderEventCalendar() {
    const grid = document.getElementById('calGrid');
    const monthLabel = document.getElementById('calMonthLabel');
    if (!grid || !monthLabel) return;

    const today = getTodayStr();
    monthLabel.textContent = `${calYear} 年 ${calMonth + 1} 月`;

    // 整理每日活動分類（upcoming / past）
    const eventMap = {};
    state.events.forEach(evt => {
      if (!eventMap[evt.date]) eventMap[evt.date] = { upcoming: 0, past: 0 };
      if (!evt.archived && evt.date >= today) {
        eventMap[evt.date].upcoming += 1;
      } else {
        eventMap[evt.date].past += 1;
      }
    });

    const firstDayWeekday = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

    grid.innerHTML = '';

    for (let i = 0; i < firstDayWeekday; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'cal-day is-empty';
      grid.appendChild(emptyCell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const info = eventMap[dateStr];

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day';
      if (dateStr === today) btn.classList.add('is-today');
      if (dateStr === calSelectedDate) btn.classList.add('is-selected');

      let dotHtml = '';
      if (info) {
        if (info.upcoming > 0) {
          btn.classList.add('has-upcoming');
          dotHtml = '<span class="cal-dot upcoming"></span>';
        } else if (info.past > 0) {
          btn.classList.add('has-past-only');
          dotHtml = '<span class="cal-dot past"></span>';
        }
      }

      btn.innerHTML = `<span>${d}</span>${dotHtml}`;
      btn.addEventListener('click', () => {
        calSelectedDate = dateStr;
        renderEventCalendar();
      });
      grid.appendChild(btn);
    }

    renderCalendarDetail();
  }

  function renderCalendarDetail() {
    const dateLabel = document.getElementById('calSelectedDateLabel');
    const detailList = document.getElementById('calDetailList');
    if (!dateLabel || !detailList) return;

    const today = getTodayStr();
    const [y, m, d] = calSelectedDate.split('-').map(Number);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const wd = weekdays[new Date(y, m - 1, d).getDay()];
    dateLabel.textContent = `${calSelectedDate}（週${wd}）`;

    const dayEvents = state.events.filter(e => e.date === calSelectedDate);
    detailList.innerHTML = '';

    if (dayEvents.length === 0) {
      detailList.innerHTML = '<div class="empty-state" style="padding:24px 12px;">這一天目前沒有排定活動。</div>';
      return;
    }

    dayEvents.forEach(evt => {
      const isPast = evt.archived || evt.date < today;
      const item = document.createElement('div');
      item.className = `cal-detail-item${isPast ? ' is-past' : ''}`;

      const metaParts = [
        evt.time ? `時間：${evt.time}` : '時間：未填寫',
        evt.location ? `地點：${evt.location}` : '地點：未填寫'
      ];

      item.innerHTML = `
        <div class="cal-detail-top">
          <span class="cal-detail-title">${escapeHtml(evt.name)}</span>
          <button type="button" class="text-btn" data-cal-edit>編輯</button>
        </div>
        <div class="cal-detail-meta">${escapeHtml(metaParts.join('｜'))}</div>
        <div class="cal-detail-meta">提醒日：${escapeHtml(evt.remindDate)}${evt.archived ? '（已歸檔）' : ''}</div>
        ${evt.note ? `<div class="cal-detail-note">備註：${escapeHtml(evt.note)}</div>` : ''}
      `;

      item.querySelector('[data-cal-edit]').addEventListener('click', () => openEventEditModal(evt));
      detailList.appendChild(item);
    });
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
  initFirebaseAuth();
})();