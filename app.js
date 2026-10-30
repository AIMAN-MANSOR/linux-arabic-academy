/* Linux AR — Supabase-connected learning platform.
 * Client-side terminal/editor are deliberately sandboxed simulations.
 * Telegram account linking and membership checks are server-side Edge Function actions.
 */
(() => {
  'use strict';

  const PAGE_SIZE = 30;
  const LABELS = { beginner: 'مبتدئ', intermediate: 'متوسط', advanced: 'متقدم' };
  const PAGE_TITLES = {
    dashboard: 'لوحة التعلّم', paths: 'مسارات التعلّم', library: 'موسوعة الأوامر',
    lab: 'مختبر الطرفية', quizzes: 'الاختبارات', achievements: 'الإنجازات', profile: 'حسابي'
  };
  const config = window.PLATFORM_CONFIG || {};
  const supabaseClient = window.supabase?.createClient && config.supabaseUrl && config.supabaseAnonKey
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    }) : null;

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);

  let commands = [];
  let authUser = null;
  let currentUser = '';
  let activeCommand = null;
  let currentView = 'dashboard';
  let page = 1;
  let quizState = null;
  let authMode = 'login';
  let toastTimer = null;
  let profile = emptyProfile();
  let telegramVerified = false;
  let terminalCwd = '/home/learner';
  let terminalHistory = [];
  const virtualDirectories = new Set(['/','/home','/home/learner','/home/learner/Documents','/home/learner/Downloads','/home/learner/projects']);
  const virtualFiles = new Map([
    ['/home/learner/.bashrc', '# Linux AR training shell\n'],
    ['/home/learner/Documents/notes.txt', 'Welcome to Linux AR.\n'],
    ['/home/learner/projects/README.md', '# My first Linux project\n']
  ]);

  function emptyProfile() {
    return { completed: [], passed: [], quizScores: {}, quizAttempts: {}, challengeDone: false, lastActivity: Date.now() };
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.authMode === mode);
    });
    $('registerUsernameWrap').classList.toggle('hidden', mode !== 'register');
    $('authUsername').required = mode === 'register';
    $('authPassword').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('authSubmit').innerHTML = mode === 'register'
      ? 'إنشاء حساب <span>←</span>'
      : 'دخول إلى المنصة <span>←</span>';
    $('authNote').textContent = mode === 'register'
      ? 'اسم العرض من 3 إلى 24 حرفًا إنجليزيًا أو رقمًا أو _، وسيظهر في حسابك.'
      : 'أدخل البريد الإلكتروني وكلمة المرور اللذين سجلت بهما.';
    $('authError').textContent = '';
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!supabaseClient) {
      $('authError').textContent = 'إعداد Supabase غير مكتمل. تحقق من ملف config.js.';
      return;
    }
    const email = $('authEmail').value.trim().toLowerCase();
    const password = $('authPassword').value;
    const username = $('authUsername').value.trim();
    $('authSubmit').disabled = true;
    $('authSubmit').textContent = 'جارٍ الاتصال...';
    $('authError').textContent = '';
    try {
      if (password.length < 8) throw new Error('كلمة المرور يجب أن تتكون من 8 أحرف على الأقل.');
      if (authMode === 'register') {
        if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) throw new Error('اسم العرض يجب أن يتكون من 3 إلى 24 حرفًا إنجليزيًا أو رقمًا أو _.');
        const { data: available, error: availabilityError } = await supabaseClient.rpc('is_username_available', { p_username: username });
        if (availabilityError) throw new Error('تعذر التحقق من اسم العرض. شغّل ملف SQL المرفق في Supabase ثم حاول مجددًا.');
        if (!available) throw new Error('اسم العرض مستخدم بالفعل. اختر اسمًا آخر.');
        const { data, error } = await supabaseClient.auth.signUp({
          email, password, options: { data: { username }, emailRedirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
        if (data.session) {
          await enterApp(data.user);
        } else {
          setAuthMode('login');
          $('authEmail').value = email;
          $('authError').style.color = 'var(--green)';
          $('authError').textContent = 'تم إنشاء الحساب. افتح رسالة التأكيد التي أرسلناها إلى بريدك، ثم ارجع وسجّل الدخول.';
        }
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await enterApp(data.user);
      }
    } catch (error) {
      $('authError').style.color = '#ff8d9f';
      $('authError').textContent = error.message || 'تعذر إتمام العملية. تحقق من البيانات وحاول مجددًا.';
    } finally {
      $('authSubmit').disabled = false;
      $('authSubmit').innerHTML = authMode === 'register' ? 'إنشاء حساب <span>←</span>' : 'دخول إلى المنصة <span>←</span>';
    }
  }

  async function loadServerProfile(user) {
    const fresh = emptyProfile();
    const [profileResult, progressResult, quizResult] = await Promise.all([
      supabaseClient.from('profiles').select('username').eq('id', user.id).maybeSingle(),
      supabaseClient.from('lesson_progress').select('lesson_id,completed').eq('user_id', user.id),
      supabaseClient.from('quiz_results').select('quiz_id,score').eq('user_id', user.id).order('completed_at', { ascending: false })
    ]);
    if (profileResult.error) throw profileResult.error;
    if (progressResult.error) throw progressResult.error;
    if (quizResult.error) throw quizResult.error;
    const username = profileResult.data?.username || user.user_metadata?.username || user.email?.split('@')[0] || 'learner';
    for (const row of (progressResult.data || [])) {
      if (!row.completed) continue;
      if (row.lesson_id.startsWith('command:')) {
        const id = Number(row.lesson_id.slice(8));
        if (Number.isInteger(id)) fresh.completed.push(id);
      }
      if (row.lesson_id === 'challenge:daily') fresh.challengeDone = true;
    }
    for (const row of (quizResult.data || [])) {
      const level = row.quiz_id;
      if (!['beginner','intermediate','advanced'].includes(level)) continue;
      fresh.quizAttempts[level] = (fresh.quizAttempts[level] || 0) + 1;
      fresh.quizScores[level] = Math.max(fresh.quizScores[level] || 0, Number(row.score) || 0);
      if (Number(row.score) >= 80 && !fresh.passed.includes(level)) fresh.passed.push(level);
    }
    fresh.completed = [...new Set(fresh.completed)];
    return { username, profile: fresh };
  }

  async function enterApp(user) {
    if (!user) return;
    authUser = user;
    $('authError').textContent = '';
    $('authError').style.color = '';
    try {
      const loaded = await loadServerProfile(user);
      currentUser = loaded.username;
      profile = loaded.profile;
      $('authScreen').classList.add('hidden');
      $('appShell').classList.remove('hidden');
      $('connectionStatus').textContent = 'متصل بـ Supabase';
      $('demoWarning').textContent = 'المصادقة والتقدم مرتبطان بحسابك. مساحة الطرفية ومحرر الأكواد محاكاة آمنة داخل المتصفح وليسا خادماً حقيقياً.';
      $('telegramLink').href = config.telegramChannelUrl || 'https://t.me/something_37';
      updateUserUI();
      await refreshTelegramStatus(false);
      renderAll();
      navigate('dashboard');
    } catch (error) {
      console.error(error);
      toast('تم تسجيل الدخول، لكن تعذر تحميل بيانات الحساب. تحقق من جداول Supabase وسياسات RLS.');
    }
  }

  async function leaveApp() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    authUser = null;
    currentUser = '';
    telegramVerified = false;
    profile = emptyProfile();
    $('appShell').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
    $('authForm').reset();
    $('authError').textContent = '';
    setAuthMode('login');
  }

  async function saveProfile() {
    profile.lastActivity = Date.now();
    if (!authUser || !supabaseClient || !profile.challengeDone) return;
    const { error } = await supabaseClient.from('lesson_progress').upsert({
      user_id: authUser.id, lesson_id: 'challenge:daily', completed: true, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,lesson_id' });
    if (error) console.warn('Progress sync failed:', error.message);
  }

  async function persistCommandProgress(id, completed) {
    if (!authUser || !supabaseClient) return;
    const { error } = await supabaseClient.from('lesson_progress').upsert({
      user_id: authUser.id, lesson_id: `command:${id}`, completed, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,lesson_id' });
    if (error) {
      toast('تعذر حفظ تقدم الأمر. تحقق من سياسة lesson_progress في Supabase.');
      console.error(error);
    }
  }

  function updateUserUI() {
    const first = currentUser.slice(0, 1).toUpperCase();
    $('topUsername').textContent = currentUser;
    $('welcomeName').textContent = currentUser;
    $('userAvatar').textContent = first;
    $('profileAvatar').textContent = first;
    $('profileUsername').textContent = currentUser;
    $('topLevel').textContent = 'مستوى ' + LABELS[getCurrentLevel()];
    $('currentLevel').textContent = LABELS[getCurrentLevel()];
    $('profileLevel').textContent = LABELS[getCurrentLevel()];
  }

  function getCurrentLevel() {
    if (profile.passed.includes('intermediate') && telegramVerified) return 'advanced';
    if (profile.passed.includes('beginner') && telegramVerified) return 'intermediate';
    return 'beginner';
  }

  async function createTelegramLink() {
    if (!authUser) return;
    $('telegramMessage').textContent = 'جارٍ إنشاء رابط آمن صالح لمدة قصيرة...';
    const { data, error } = await supabaseClient.functions.invoke('telegram-gateway', { body: { action: 'create-link' } });
    if (error || !data?.url) {
      $('telegramMessage').textContent = 'تعذر إنشاء الرابط. تأكد من نشر وظيفة telegram-gateway وإعداد أسرارها.';
      console.error(error || data);
      return;
    }
    $('telegramStartLink').href = data.url;
    $('telegramStartLink').classList.remove('hidden');
    $('telegramMessage').textContent = `الرابط جاهز وصالح حتى ${new Date(data.expires_at).toLocaleTimeString('ar')}. افتحه واضغط Start في البوت، ثم اشترك في القناة.`;
  }

  async function refreshTelegramStatus(showMessage = true) {
    if (!authUser || !supabaseClient) return false;
    try {
      const { data, error } = await supabaseClient.functions.invoke('telegram-gateway', { body: { action: 'verify-membership' } });
      if (error) throw error;
      telegramVerified = data?.member === true;
      if (showMessage) {
        $('telegramMessage').textContent = telegramVerified
          ? 'تم تأكيد اشتراكك وربط حساب Telegram بنجاح. المستوى المتوسط مفتوح الآن.'
          : data?.linked === false
            ? 'لم تربط حساب Telegram بعد. أنشئ الرابط وافتح البوت واضغط Start.'
            : 'لم نجد اشتراكاً نشطاً في القناة. اشترك أولاً ثم أعد التحقق.';
      }
      renderDashboard(); renderPaths(); renderLibrary(); renderQuizzes();
      return telegramVerified;
    } catch (error) {
      if (showMessage) $('telegramMessage').textContent = 'خدمة التحقق غير جاهزة بعد. تأكد من نشر وظيفة الخادم وضبط TELEGRAM_WEBHOOK_SECRET.';
      console.warn('Telegram verification unavailable:', error.message || error);
      telegramVerified = false;
      return false;
    }
  }

  function classifyCommand(command, description) {
    const s = `${command} ${description}`.toLowerCase();
    const rules = [
      ['الشبكات والاتصالات', /\b(ip |ip$|ping|traceroute|tracepath|mtr|dig|nslookup|host |curl|wget|nc |netcat|ss |netstat|ethtool|nmcli|nmtui|tcpdump|wireshark|iptables|nft|firewall|ufw|route|arp)\b/],
      ['المستخدمون والصلاحيات', /\b(whoami|users|who |w$|groups|id$|passwd|chage|useradd|usermod|userdel|groupadd|groupdel|getent|sudo|su |chmod|chown|chgrp|umask|visudo|faillock)\b/],
      ['العمليات والأداء', /\b(ps |top|htop|pgrep|pkill|kill|nice|renice|jobs|bg|fg|nohup|timeout|watch|pstree|pidof|lsof|fuser|strace|ltrace|free|vmstat|iostat|mpstat|iotop|uptime|lscpu|lsmem)\b/],
      ['التخزين والملفات', /\b(ls|pwd|cd |mkdir|rmdir|touch|cp |mv |rm |find |locate|tree|file |stat |du |df |lsblk|blkid|findmnt|mount|umount|fdisk|parted|mkfs|fsck|dd |ln |readlink|basename|dirname|split|truncate)\b/],
      ['النصوص والبحث', /\b(cat|tac|less|more|head|tail|grep|egrep|fgrep|rg |ack |wc |sort|uniq|cut|paste|join|rev|tr |sed|awk|diff|comm|xargs|tee|strings|iconv)\b/],
      ['الخدمات والسجلات', /\b(systemctl|service |journalctl|logger|logrotate|dmesg|sysctl|systemd-analyze|init |runlevel|chkconfig)\b/],
      ['الأرشفة والضغط', /\b(tar |gzip|gunzip|bzip2|bunzip2|xz |unxz|zip |unzip|7z|zstd|lz4)\b/],
      ['الأتمتة والصدفة', /\b(bash|sh |zsh|shell|cron|crontab|at |atq|atrm|sleep|echo|printf|export|env|printenv|alias|unalias|source|declare|read |test |set |shift|trap)\b/],
      ['الحزم والبرامج', /\b(apt|apt-get|dpkg|yum|dnf|rpm|pacman|zypper|snap|flatpak|pip|npm|gem)\b/],
      ['التشفير والسلامة', /\b(sha256sum|sha512sum|md5sum|sha1sum|openssl|gpg|gpg2|ssh-keygen|cryptsetup|encfs|age |base64|shasum)\b/],
      ['التطوير وإدارة الإصدارات', /\b(git |git$|gcc|g\+\+|make|cmake|python|python3|perl|ruby|php|node|npm|jq|yq|sqlite|mysql|psql|docker|podman|kubectl|vagrant|ansible)\b/]
    ];
    for (const [name, regex] of rules) if (regex.test(s)) return name;
    return 'أدوات النظام المتنوعة';
  }

  const categoryIcons = {
    'الشبكات والاتصالات': '⌁', 'المستخدمون والصلاحيات': '♙', 'العمليات والأداء': '◴',
    'التخزين والملفات': '▤', 'النصوص والبحث': '⌕', 'الخدمات والسجلات': '≋',
    'الأرشفة والضغط': '▧', 'الأتمتة والصدفة': '>_', 'الحزم والبرامج': '⬡',
    'التشفير والسلامة': '◇', 'التطوير وإدارة الإصدارات': '⌘', 'أدوات النظام المتنوعة': '⊞'
  };

  function enrichCommands() {
    commands = commands.map((item) => ({ ...item, category: classifyCommand(item.command, item.description) }));
    const categories = [...new Set(commands.map((c) => c.category))].sort((a, b) => a.localeCompare(b, 'ar'));
    $('categoryFilter').innerHTML = '<option value="all">كل المجموعات</option>' + categories.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    $('resultsCount').textContent = `تم تحميل ${commands.length.toLocaleString('en-US')} أمر`;
  }

  async function loadCommands() {
    try {
      const response = await fetch('./commands.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data) || data.length !== 1500) throw new Error('ملف الأوامر غير مكتمل');
      commands = data;
      enrichCommands();
      renderLibrary();
    } catch (error) {
      $('resultsCount').textContent = 'تعذر تحميل ملف commands.json';
      $('commandGrid').innerHTML = `<div class="panel">تعذر تحميل الموسوعة. شغّل الموقع عبر خادم محلي، وتأكد من وجود commands.json بجوار index.html. <small>${escapeHTML(error.message)}</small></div>`;
    }
  }

  function navigate(view) {
    if (!PAGE_TITLES[view]) return;
    currentView = view;
    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
    document.querySelectorAll('.nav-item[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    $('pageTitle').textContent = PAGE_TITLES[view];
    $('sidebar').classList.remove('open');
    if (view === 'dashboard') renderDashboard();
    if (view === 'paths') renderPaths();
    if (view === 'library') renderLibrary();
    if (view === 'quizzes') renderQuizzes();
    if (view === 'achievements') renderAchievements();
    if (view === 'profile') renderProfile();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderAll() {
    renderDashboard(); renderPaths(); renderLibrary(); renderQuizzes(); renderAchievements(); renderProfile();
  }

  const tracks = [
    { name: 'أساسيات Linux', level: 'beginner', icon: '⌘', color: 'cyan', description: 'التعرّف على الطرفية والملفات والمسارات والأوامر اليومية.', topics: ['التنقل وإدارة الملفات', 'قراءة النصوص والبحث', 'معلومات النظام'] },
    { name: 'إدارة النظام', level: 'intermediate', icon: '⚙', color: 'violet', description: 'إدارة المستخدمين والعمليات والخدمات والتخزين.', topics: ['المستخدمون والصلاحيات', 'العمليات والخدمات', 'السجلات والتخزين'] },
    { name: 'الشبكات والأمن', level: 'advanced', icon: '⬡', color: 'pink', description: 'أدوات الشبكات والتدقيق الدفاعي والتشفير والأتمتة.', topics: ['تشخيص الشبكات', 'التشفير والتحقق', 'الأتمتة والتدقيق'] }
  ];

  function levelUnlocked(level) {
    if (level === 'beginner') return true;
    if (level === 'intermediate') return profile.passed.includes('beginner') && telegramVerified;
    return profile.passed.includes('intermediate') && telegramVerified;
  }

  function renderDashboard() {
    const done = profile.completed.length;
    const pct = Math.round((done / 1500) * 100);
    $('completedCount').textContent = done.toLocaleString('en-US');
    $('progressPercent').textContent = `${pct}%`;
    $('progressBar').style.width = `${pct}%`;
    $('trackProgress').style.width = `${Math.min(100, Math.round(done / 548 * 100))}%`;
    $('currentLevel').textContent = LABELS[getCurrentLevel()];
    $('topLevel').textContent = `مستوى ${LABELS[getCurrentLevel()]}`;
    $('nextMilestone').textContent = profile.passed.includes('beginner') ? 'اجتزت اختبار المبتدئ' : 'أكمل دروس المبتدئين ثم اختبر نفسك';
    $('dashboardTracks').innerHTML = tracks.map((track, i) => {
      const unlocked = levelUnlocked(track.level);
      return `<article class="track-card" data-number="0${i + 1}"><div class="track-top"><span class="track-symbol ${track.color}">${track.icon}</span><div><h3>${track.name}</h3><small>${LABELS[track.level]} · ${unlocked ? 'متاح' : 'مقفل'}</small></div></div><p>${track.description}</p><div class="track-bottom"><span>${track.topics.length} محاور تعليمية</span><b>${unlocked ? 'استكشف المسار ←' : 'يتطلب اجتياز المرحلة السابقة'}</b></div></article>`;
    }).join('');
    $('dashboardTracks').querySelectorAll('.track-card').forEach((card) => card.addEventListener('click', () => navigate('paths')));
    updateUserUI();
  }

  function renderPaths() {
    const cards = tracks.map((track, i) => {
      const unlocked = levelUnlocked(track.level);
      const passed = profile.passed.includes(track.level);
      return `<article class="roadmap-card ${unlocked ? '' : 'locked'}"><span class="roadmap-number">PHASE 0${i + 1} · ${track.level.toUpperCase()}</span><h3>${track.name}</h3><p>${track.description}</p><ul>${track.topics.map((t) => `<li>${t}</li>`).join('')}</ul><div class="roadmap-status"><span>${passed ? 'اجتزت الاختبار' : unlocked ? 'متاح للتعلم' : 'مقفل'}</span><b>${passed ? '✓ مكتمل' : unlocked ? 'ابدأ الاختبار' : '🔒'}</b></div></article>`;
    }).join('');
    $('levelRoadmap').innerHTML = cards;
    const counts = commands.reduce((acc, c) => (acc[c.category] = (acc[c.category] || 0) + 1, acc), {});
    $('categoryGrid').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `<button class="category-card" data-category="${escapeHTML(name)}"><span class="category-icon">${categoryIcons[name] || '⌘'}</span><span><b>${escapeHTML(name)}</b><small>${count.toLocaleString('en-US')} أمر</small></span></button>`).join('');
    $('categoryGrid').querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
      $('categoryFilter').value = button.dataset.category;
      $('commandSearch').value = '';
      page = 1; navigate('library');
    }));
  }

  function renderLibrary() {
    if (!commands.length) return;
    const query = $('commandSearch').value.trim().toLowerCase();
    const level = $('levelFilter').value;
    const category = $('categoryFilter').value;
    const filtered = commands.filter((c) => {
      const matchesQuery = !query || c.command.toLowerCase().includes(query) || c.description.toLowerCase().includes(query) || c.category.toLowerCase().includes(query);
      return levelUnlocked(c.level) && matchesQuery && (level === 'all' || c.level === level) && (category === 'all' || c.category === category);
    });
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages);
    const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    $('resultsCount').textContent = `عرض ${shown.length.toLocaleString('en-US')} من ${filtered.length.toLocaleString('en-US')} نتيجة · صفحة ${page} من ${pages}`;
    $('commandGrid').innerHTML = shown.length ? shown.map((c) => {
      const isDone = profile.completed.includes(c.id);
      return `<article class="command-card" data-command-id="${c.id}" tabindex="0" role="button" aria-label="تفاصيل الأمر ${escapeHTML(c.command)}"><div class="command-card-top"><span class="command-id">#${c.id} · ${escapeHTML(c.category)}</span><span class="level-pill ${c.level}">${LABELS[c.level]}</span></div><div class="command-code">${escapeHTML(c.command)}</div><p class="command-description">${escapeHTML(c.description)}</p><div class="command-card-bottom"><span>${isDone ? '<b class="done-mark">✓ تعلّمته</b>' : 'عرض التفاصيل'}</span><span>التفاصيل ←</span></div></article>`;
    }).join('') : '<div class="panel">لا توجد نتائج مطابقة. جرّب كلمة بحث أخرى.</div>';
    $('commandGrid').querySelectorAll('[data-command-id]').forEach((card) => {
      const open = () => openCommand(Number(card.dataset.commandId));
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
    $('pagination').innerHTML = pages > 1 ? `<button ${page === 1 ? 'disabled' : ''} data-page="${page - 1}">السابق</button><span>${page} / ${pages}</span><button ${page === pages ? 'disabled' : ''} data-page="${page + 1}">التالي</button>` : '';
    $('pagination').querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => { page = Number(button.dataset.page); renderLibrary(); }));
  }

  const commandKnowledge = {
    ls: ['عرض أسماء الملفات والمجلدات داخل مسار. يقرأ إدخالات المجلد ولا يغيّر محتواه.', 'ls [خيارات] [مسار]', ['-l: تفاصيل الصلاحيات والمالك والحجم','-a: إظهار الملفات المخفية','-h: أحجام مقروءة للبشر مع -l'], 'ابدأ بـ ls، ثم جرّب ls -lah لعرض الملفات المخفية مع التفاصيل.', 'من أكثر أوامر الاستكشاف استخداماً قبل تعديل الملفات أو تشغيل البرامج.', 'عدم ظهور ملف لا يعني أنه غير موجود؛ قد يكون مخفياً أو لا تملك صلاحية رؤية المجلد.'],
    pwd: ['يعرض المسار المطلق للمجلد الحالي في الصدفة. لا ينتقل بين المجلدات ولا يغيّر الملفات.', 'pwd [خيارات]', ['-L: عرض المسار المنطقي الذي قد يحافظ على الروابط الرمزية','-P: عرض المسار الفعلي بعد حل الروابط الرمزية'], 'نفّذ pwd قبل استخدام مسار نسبي حتى تعرف نقطة انطلاقك.', 'مفيد في السكربتات وتحديد مكان العمل قبل أوامر النسخ والحذف.', 'المسار النسبي يعتمد على المجلد الحالي؛ لذلك قد يعطي الأمر نفسه نتائج مختلفة حسب مكانك.'],
    cd: ['يغيّر مجلد العمل الحالي للصدفة، ويؤثر في تفسير المسارات النسبية للأوامر التالية.', 'cd [مسار]', ['..: المجلد الأب','~: المجلد الشخصي','-: المجلد السابق'], 'جرّب cd Documents ثم pwd، وبعدها cd .. للعودة خطوة.', 'التنقل بين مجلدات المشروع أو الوصول إلى ملفات النظام.', 'cd أمر داخلي في الصدفة غالباً؛ تشغيله كبرنامج فرعي لن يغيّر مجلد الصدفة الأصلية.'],
    mkdir: ['يطلب من نظام الملفات إنشاء مجلد جديد. يتطلب وجود المجلد الأب وامتلاك صلاحية الكتابة فيه.', 'mkdir [خيارات] اسم_المجلد', ['-p: إنشاء المجلدات الأب الناقصة وعدم الفشل إذا كانت موجودة','-v: عرض ما تم إنشاؤه'], 'mkdir -p Projects/Python ينشئ المسار المتداخل دفعة واحدة.', 'تنظيم ملفات المشاريع وفصل الشيفرة والاختبارات والتوثيق.', 'بدون -p قد يفشل الأمر عندما لا يوجد المجلد الأب.'],
    touch: ['ينشئ ملفاً فارغاً إذا لم يكن موجوداً، أو يحدّث أوقات الوصول/التعديل إذا كان موجوداً.', 'touch [خيارات] ملف', ['-c: لا تنشئ الملف إذا كان غير موجود','-t: تحديد وقت مرجعي بصيغة موثقة'], 'touch notes.txt ثم ls -l لملاحظة ظهور الملف.', 'إنشاء ملفات إعداد أو ملفات فارغة قبل فتحها بمحرر.', 'touch لا يكتب محتوى الملف؛ استخدم محرراً أو أداة كتابة مناسبة لإضافة النص.'],
    cp: ['ينسخ ملفاً أو مجلداً إلى وجهة أخرى. يحتاج صلاحية قراءة المصدر وكتابة الوجهة.', 'cp [خيارات] المصدر الوجهة', ['-r أو -R: نسخ المجلدات بشكل متكرر','-i: السؤال قبل استبدال ملف','-p: محاولة الحفاظ على الصلاحيات والأوقات'], 'cp notes.txt notes-backup.txt ينشئ نسخة مستقلة من الملف.', 'النسخ الاحتياطي وإنشاء نسخة عمل قبل تعديل ملف مهم.', 'انتبه إلى الوجهة الموجودة مسبقاً؛ قد يتم استبدال محتواها حسب الخيارات.'],
    mv: ['ينقل ملفاً أو مجلداً أو يغيّر اسمه. داخل نظام الملفات نفسه قد يكون النقل إعادة تسمية في بيانات المجلد.', 'mv [خيارات] المصدر الوجهة', ['-i: السؤال قبل الاستبدال','-n: عدم استبدال وجهة موجودة','-v: عرض ما تم نقله'], 'mv draft.txt final.txt يغيّر اسم الملف.', 'تنظيم ملفات المشروع ونقلها إلى مجلدات مناسبة.', 'قد يؤدي نقل ملف إلى وجهة موجودة إلى استبدالها؛ افحص المسار قبل التنفيذ.'],
    rm: ['يحذف مراجع الملفات من نظام الملفات. لا يضع الملفات عادة في سلة محذوفات الطرفية.', 'rm [خيارات] ملف', ['-i: طلب تأكيد تفاعلي','-r: حذف المجلدات ومحتوياتها تكرارياً','-f: تجاهل بعض التأكيدات والأخطاء'], 'استخدم rm -i old.txt بعد التأكد من المسار. في مختبر الموقع الحذف افتراضي فقط.', 'إزالة ملفات مؤقتة أو غير مطلوبة بعد التأكد من النسخ الاحتياطي.', 'خطر: rm -rf مع مسار خاطئ قد يسبب فقداناً واسعاً للبيانات. لا تنفذه بصلاحيات مرتفعة دون فهم.'],
    cat: ['يقرأ محتوى ملف أو يدمج عدة ملفات ويكتب النص إلى المخرجات القياسية.', 'cat [خيارات] ملف...', ['-n: ترقيم الأسطر','-A: إظهار محارف غير مرئية وعلامات نهاية السطر'], 'cat notes.txt يعرض ملفاً صغيراً؛ للملفات الطويلة استخدم less.', 'عرض ملفات الإعداد والقراءة السريعة للمخرجات النصية.', 'cat لا يناسب الملفات الثنائية أو الملفات الكبيرة جداً.'],
    grep: ['يبحث عن نمط نصي داخل ملف أو تدفق إدخال، ويعرض الأسطر المطابقة.', 'grep [خيارات] نمط [ملف...]', ['-i: تجاهل حالة الأحرف','-n: إظهار رقم السطر','-r: البحث داخل المجلدات تكرارياً','-E: استخدام تعبيرات نمطية موسعة'], 'grep -in "error" app.log يعرض أسطر error مع أرقامها دون حساسية لحالة الأحرف.', 'تحليل السجلات والبحث عن رسالة خطأ أو إعداد داخل ملفات كثيرة.', 'النمط يُفسَّر كتعبير نمطي؛ استخدم -F للبحث عن نص حرفي عند الحاجة.'],
    find: ['يجتاز شجرة مجلدات ويقيّم شروطاً مثل نوع الملف والاسم والحجم والوقت، ثم ينفذ إجراءً اختيارياً.', 'find مسار [شروط] [إجراء]', ['-type f: ملفات عادية','-type d: مجلدات','-name: مطابقة الاسم','-mtime: التعديل بالأيام','-exec: تشغيل إجراء على النتائج'], 'find . -type f -name "*.log" يبحث عن ملفات السجل داخل المسار الحالي.', 'إدارة الملفات والسجلات والبحث عن ملفات قديمة أو كبيرة.', 'ضع الأنماط التي تحتوي * بين علامات اقتباس حتى لا توسعها الصدفة قبل وصولها إلى find.'],
    chmod: ['يعدّل بتات صلاحيات القراءة والكتابة والتنفيذ للمالك والمجموعة والآخرين.', 'chmod [خيارات] MODE ملف', ['755: المالك rwx والمجموعة/الآخرون r-x','644: المالك rw والمجموعة/الآخرون r','-R: تطبيق تكراري على شجرة ملفات'], 'chmod 750 script.sh يمنح المالك كامل الصلاحيات والمجموعة القراءة والتنفيذ.', 'تحديد من يستطيع قراءة ملف أو تشغيل سكربت.', 'لا تمنح 777 كحل سريع؛ قلّل الصلاحيات إلى الحد المطلوب فقط.'],
    chown: ['يغيّر مالك الملف أو مجموعته. غالباً يحتاج إلى صلاحيات إدارية لتغيير المالك.', 'chown [خيارات] USER[:GROUP] ملف', ['-R: تغيير الملكية تكرارياً','--reference: نسخ الملكية من ملف مرجعي'], 'sudo chown learner:learner report.txt يضبط المالك والمجموعة.', 'تصحيح ملكية الملفات بعد نقلها أو إنشاءها بواسطة خدمة.', 'تحقق من المسار قبل استخدام -R لأنه يؤثر في كل المحتويات.'],
    ps: ['يعرض لقطة عن العمليات الجارية ومعلومات مثل PID والحالة واستهلاك الموارد.', 'ps [خيارات]', ['aux: عرض عمليات جميع المستخدمين بصيغة BSD','-ef: تنسيق كامل شائع','-o: اختيار أعمدة العرض'], 'ps aux | grep nginx مثال معروف للبحث، لكن المحاكاة لا تدعم الأنابيب.', 'فهم ما يعمل على النظام وتشخيص برنامج لا يستجيب.', 'النتيجة لقطة زمنية؛ استخدم top أو htop للمراقبة المتجددة.'],
    kill: ['يرسل إشارة إلى عملية محددة بواسطة PID؛ الاسم لا يعني دائماً إنهاء العملية فوراً.', 'kill [إشارة] PID', ['-TERM: طلب إنهاء منظم وهو الافتراضي غالباً','-STOP: إيقاف مؤقت','-CONT: استئناف','-KILL: إنهاء قسري لا يمكن للعملية اعتراضه'], 'ابدأ بطلب الإنهاء العادي: kill -TERM 1234 بعد التأكد من PID.', 'التعامل مع عملية معلقة بعد تجربة إغلاقها بالطريقة المعتادة.', 'تأكد من PID؛ قتل عملية النظام الخاطئة قد يقطع خدمة أو جلسة.'],
    systemctl: ['واجهة لإدارة وحدات systemd مثل الخدمات والمؤقتات ونقاط التركيب.', 'systemctl [خيارات] COMMAND UNIT', ['status: عرض الحالة','start/stop: بدء أو إيقاف','enable/disable: التحكم في التشغيل عند الإقلاع','restart: إعادة تشغيل'], 'systemctl status ssh يعرض حالة خدمة SSH.', 'تشغيل خدمات الخادم وفحصها وإدارتها.', 'start لا يعني enable؛ الأولى تشغيل الآن والثانية تفعيل بدء الخدمة مع الإقلاع.'],
    journalctl: ['يقرأ سجلات systemd journal مع إمكان التصفية حسب الإقلاع أو الوحدة أو الوقت.', 'journalctl [خيارات]', ['-b: سجلات الإقلاع الحالي','-u UNIT: سجلات وحدة محددة','-f: متابعة السجلات مباشرة','-p: التصفية حسب الأولوية'], 'journalctl -u ssh -b يعرض سجلات خدمة SSH منذ الإقلاع الحالي.', 'تحليل سبب فشل الخدمات والأخطاء التي حدثت أثناء الإقلاع.', 'قد تحتاج صلاحيات أو عضوية مجموعة مناسبة لرؤية كل السجلات.'],
    ip: ['أداة حديثة لفحص وضبط واجهات الشبكة والعناوين والمسارات وجداول الجوار.', 'ip OBJECT COMMAND', ['ip addr: عناوين الواجهات','ip link: حالة الواجهات','ip route: جدول التوجيه','ip neigh: الجيران'], 'ip addr show يعرض عناوين واجهات الشبكة.', 'استكشاف الاتصال ومشكلات العناوين والتوجيه.', 'أوامر ip قد تغيّر إعدادات الشبكة؛ ابدأ بأوامر العرض قبل أوامر التعديل.'],
    ping: ['يرسل رسائل ICMP Echo إلى وجهة لقياس إمكانية الوصول وزمن الاستجابة عند السماح بها.', 'ping [خيارات] HOST', ['-c: عدد الحزم','-i: الفاصل الزمني','-W: مهلة انتظار الرد'], 'ping -c 4 1.1.1.1 يرسل أربع حزم اختبار.', 'تمييز بعض مشكلات الوصول أو التأخير في الشبكة.', 'غياب الرد لا يثبت أن الجهاز متوقف؛ قد تحجب الجهة رسائل ICMP.'],
    ss: ['يعرض مقابس الشبكة ومعلومات الاتصالات والمنافذ.', 'ss [خيارات]', ['-t: TCP','-u: UDP','-l: منافذ مستمعة','-n: أرقام دون حل أسماء','-p: معلومات العملية عند توفر الصلاحيات'], 'ss -tuln يعرض منافذ TCP وUDP المستمعة.', 'فحص الخدمات التي تستمع على منافذ الشبكة.', 'وجود منفذ مستمع لا يعني وحده وجود ثغرة؛ راجع عنوان الربط والجدار الناري والخدمة.'],
    ssh: ['ينشئ اتصالاً مشفراً بخادم بعيد باستخدام بروتوكول Secure Shell.', 'ssh [خيارات] USER@HOST', ['-p: تحديد المنفذ','-i: ملف المفتاح الخاص','-v: معلومات تشخيص الاتصال'], 'ssh learner@example.org يتصل بمضيف بعيد باسم المستخدم learner.', 'إدارة الخوادم عن بعد ونقل الأوامر عبر قناة مشفرة.', 'لا تشارك المفتاح الخاص أو كلمة المرور، وتحقق من بصمة مفتاح المضيف.'],
    tar: ['يجمع ملفات ومجلدات في أرشيف واحد، ويمكنه قراءة أرشيفات أو استخراجها.', 'tar [خيارات] ARCHIVE FILES', ['-c: إنشاء أرشيف','-x: استخراج','-t: عرض المحتويات','-f: اسم الأرشيف','-z: ضغط gzip'], 'tar -czf backup.tar.gz projects/ ينشئ أرشيفاً مضغوطاً.', 'حزم نسخ احتياطية أو توزيع ملفات مشروع.', 'اعرض المحتويات أولاً قبل الاستخراج إلى مجلد حساس.'],
    df: ['يعرض المساحة المستخدمة والمتاحة في أنظمة الملفات المركّبة.', 'df [خيارات] [مسار]', ['-h: وحدات مقروءة للبشر','-T: نوع نظام الملفات','-i: استخدام inodes'], 'df -h يوضح المساحة المتاحة على كل نظام ملفات.', 'تشخيص امتلاء القرص قبل فشل الخدمات أو عمليات الكتابة.', 'df يعرض نظام الملفات؛ du يفحص حجم الملفات والمجلدات داخل المسار.'],
    du: ['يقدّر مساحة الملفات والمجلدات عبر جمع أحجام العناصر الموجودة تحت المسار.', 'du [خيارات] [مسار]', ['-h: وحدات مقروءة للبشر','-s: ملخص لكل مسار','-d: تحديد عمق العرض'], 'du -sh ~/projects يقدّر إجمالي حجم مجلد المشاريع.', 'العثور على المجلدات التي تستهلك مساحة كبيرة.', 'قد تختلف الأرقام عن df بسبب الملفات المحذوفة التي ما زالت مفتوحة أو طريقة احتساب الكتل.'],
    free: ['يعرض حالة الذاكرة الفعلية وذاكرة swap.', 'free [خيارات]', ['-h: وحدات مقروءة للبشر','-m: ميغابايت','-s: تحديث دوري'], 'free -h يعطي نظرة سريعة على الذاكرة المتاحة.', 'تشخيص ضغط الذاكرة قبل فحص العمليات بالتفصيل.', 'Linux يستخدم الذاكرة غير المستعملة للتخزين المؤقت؛ لا تعتبر cache كلها ذاكرة ضائعة.'],
    uname: ['يعرض معلومات النواة والنظام مثل اسم النواة والإصدار والمعمارية.', 'uname [خيارات]', ['-a: معظم المعلومات المتاحة','-r: إصدار النواة','-m: المعمارية'], 'uname -a يعرض ملخص معلومات النظام.', 'التأكد من إصدار النواة والمعمارية قبل تثبيت برامج أو تعريفات.', 'لا يعطي uname وحده كل تفاصيل التوزيعة؛ راجع /etc/os-release للتوزيعة.'],
    whoami: ['يطبع اسم المستخدم الفعّال الذي تعمل الصدفة بصلاحياته حالياً.', 'whoami', [], 'نفّذ whoami بعد استخدام sudo -i لفهم اختلاف المستخدم الفعّال.', 'تأكيد الهوية الحالية قبل تنفيذ مهام تتطلب صلاحيات.', 'قد يختلف المستخدم الفعّال عن المستخدم الذي بدأ جلسة الدخول.'],
    id: ['يعرض UID وGID والمجموعات التي ينتمي إليها المستخدم الفعّال أو المحدد.', 'id [USER]', ['-u: UID فقط','-g: GID الأساسي','-G: جميع معرفات المجموعات'], 'id learner يعرض هوية المستخدم ومجموعاته.', 'تشخيص أخطاء الصلاحيات والوصول إلى الملفات.', 'قد تحتاج إلى تسجيل خروج ودخول جديد حتى تظهر عضويات مجموعات أضيفت حديثاً.'],
    apt: ['مدير حزم لتوزيعات Debian وUbuntu؛ يجلب بيانات المستودعات ويثبت الحزم ويحدّثها.', 'sudo apt COMMAND [PACKAGE]', ['update: تحديث فهارس الحزم','upgrade: ترقية الحزم','install: تثبيت حزمة','remove: إزالة حزمة'], 'sudo apt update يحدّث فهارس المستودعات قبل التثبيت.', 'إدارة البرامج والتحديثات على توزيعات Debian-based.', 'راجع مصدر الحزمة والاسم قبل تثبيتها؛ لا تضف مستودعات عشوائية.'],
    python3: ['مشغّل لغة Python 3 لتنفيذ ملفات أو أوامر تفاعلية.', 'python3 [خيارات] [ملف.py]', ['-V: عرض الإصدار','-m: تشغيل وحدة كبرنامج','-i: وضع تفاعلي بعد تنفيذ ملف'], 'python3 --version يفحص الإصدار المثبت.', 'كتابة أدوات الأتمتة ومعالجة البيانات والمهام الدفاعية.', 'شغّل الشيفرة من مصدر موثوق واستخدم بيئة افتراضية للمشاريع.'],
    sha256sum: ['يحسب أو يتحقق من بصمات SHA-256 للملفات أو البيانات.', 'sha256sum [ملف...]', ['-c: التحقق من ملف بصمات محفوظ','-b: قراءة ثنائية'], 'sha256sum image.iso يحسب بصمة الملف للتحقق من سلامته.', 'التحقق من أن الملف لم يتغير مقارنة ببصمة موثوقة.', 'البصمة لا تشفّر الملف ولا تثبت المصدر ما لم تحصل على البصمة من قناة موثوقة.'],
    curl: ['ينقل البيانات من وإلى عناوين URL ويدعم بروتوكولات متعددة.', 'curl [خيارات] URL', ['-I: طلب الترويسات فقط','-L: اتباع التحويلات','-o: حفظ الناتج في ملف','-d: إرسال بيانات طلب'], 'curl -I https://example.org يفحص ترويسات الاستجابة.', 'اختبار واجهات الويب وواجهات API وتشخيص HTTP.', 'تحقق من الرابط والوجهة قبل إرسال بيانات حساسة أو تنزيل ملفات.'],
    wget: ['ينزّل محتوى من عناوين URL ويحفظه محلياً.', 'wget [خيارات] URL', ['-O: تحديد اسم الملف','-c: استكمال تنزيل مدعوم','-q: تقليل المخرجات'], 'wget -O page.html https://example.org يحفظ الصفحة باسم محدد.', 'تنزيل ملفات أو نسخ موارد عامة.', 'تحقق من مصدر الملفات وتوقيعاتها قبل تشغيلها.'],
    sudo: ['يشغّل أمراً بصلاحيات مستخدم آخر وفق سياسة sudoers، وغالباً بصلاحيات root.', 'sudo [خيارات] COMMAND', ['-u USER: تحديد المستخدم الهدف','-l: عرض الأوامر المسموح بها','-k: إبطال بيانات الاعتماد المخزنة مؤقتاً'], 'sudo systemctl status ssh يعرض حالة خدمة بصلاحيات مناسبة.', 'تنفيذ مهام إدارية محددة دون العمل طوال الوقت بحساب root.', 'افهم الأمر الذي يلي sudo؛ لا تستخدمه لتجاوز تحذير لا تعرف سببه.'],
    passwd: ['يغيّر كلمة مرور حساب مستخدم وفق سياسات المصادقة المحلية.', 'passwd [USER]', ['-l: قفل كلمة المرور للحساب','-u: فتح القفل','-e: إجبار تغييرها عند الدخول التالي'], 'passwd يغيّر كلمة مرور حسابك الحالي.', 'إدارة بيانات اعتماد حسابات النظام.', 'لا تكتب كلمة المرور في سطر الأوامر أو تشاركها؛ أدخلها في مطالبة النظام فقط.'],
    less: ['يفتح عارضاً تفاعلياً للملفات النصية يتيح التنقل والبحث دون تحميل الملف كله إلى واجهة عرض بسيطة.', 'less [خيارات] ملف', ['Space: الصفحة التالية','b: الصفحة السابقة','/: البحث للأمام','q: الخروج'], 'less /var/log/syslog يفتح سجل النظام للقراءة.', 'قراءة السجلات والملفات الطويلة دون إغراق الطرفية.', 'اخرج بالحرف q؛ واستخدم صلاحيات القراءة المناسبة بدلاً من تغيير صلاحيات الملف.'],
    head: ['يعرض بداية الملف، وعادةً أول عشرة أسطر.', 'head [خيارات] ملف', ['-n N: تحديد عدد الأسطر','-c N: تحديد عدد البايتات'], 'head -n 20 app.log يعرض أول عشرين سطراً.', 'معاينة بداية ملفات البيانات والسجلات.', 'تأكد من اختيار عدد أسطر مناسب؛ قد يحتوي أول الملف على بيانات وصفية فقط.'],
    tail: ['يعرض نهاية الملف، ويمكنه متابعة نمو الملف عند استخدام خيار المتابعة.', 'tail [خيارات] ملف', ['-n N: تحديد عدد الأسطر','-f: متابعة الإضافات الجديدة','-F: متابعة الملف مع إعادة فتحه عند تدويره'], 'tail -n 30 app.log يعرض آخر ثلاثين سطراً.', 'متابعة السجلات عند تشخيص خطأ يحدث الآن.', 'قد تحتاج صلاحيات قراءة السجل؛ لا تشارك محتويات قد تتضمن أسراراً أو بيانات شخصية.'],
    wc: ['يحسب عدد الأسطر والكلمات والبايتات أو المحارف في الملفات.', 'wc [خيارات] ملف', ['-l: عدد الأسطر','-w: عدد الكلمات','-c: عدد البايتات','-m: عدد المحارف'], 'wc -l commands.txt يحسب عدد الأسطر.', 'قياس حجم النصوص والتحقق من عدد السجلات.', 'عدد البايتات قد يختلف عن عدد المحارف في النصوص متعددة البايتات مثل العربية.'],
    sort: ['يرتب أسطر النص وفق ترتيب لغوي أو رقمي أو خيارات مقارنة أخرى.', 'sort [خيارات] ملف', ['-n: ترتيب رقمي','-r: ترتيب عكسي','-u: إزالة الأسطر المكررة أثناء الترتيب','-k: تحديد مفتاح الترتيب'], 'sort -n scores.txt يرتب القيم الرقمية.', 'ترتيب قوائم المستخدمين أو نتائج الفحوص أو البيانات النصية.', 'الترتيب النصي الافتراضي ليس دائماً ترتيباً رقمياً؛ استخدم -n للأرقام.'],
    uniq: ['يعالج الأسطر المتكررة المتجاورة في النص، وغالباً يُستخدم بعد sort.', 'uniq [خيارات] [ملف]', ['-c: إظهار عدد التكرارات','-d: إظهار الأسطر المكررة فقط','-u: إظهار الأسطر غير المكررة'], 'sort names.txt | uniq -c يحسب تكرار الأسماء بعد ترتيبها في نظام حقيقي.', 'إزالة أو عدّ القيم المتكررة في ملفات نصية.', 'لا يكتشف كل التكرارات غير المتجاورة ما لم ترتب البيانات أولاً.'],
    cut: ['يستخرج حقولاً أو نطاقات محارف أو بايتات من كل سطر نصي.', 'cut [خيارات] ملف', ['-d: فاصل الحقول','-f: أرقام الحقول','-c: نطاق المحارف'], 'cut -d: -f1 /etc/passwd يستخرج أسماء الحسابات من الملف.', 'استخراج أعمدة محددة من ملفات مفصولة بفواصل أو نقطتين.', 'اختر فاصل الحقول الصحيح وتذكر أن cut لا يحلل CSV المعقد مع الاقتباسات تلقائياً.'],
    sed: ['محرر تدفق يعالج النص سطراً بسطر وفق أوامر مثل الاستبدال والحذف والطباعة.', 'sed [خيارات] SCRIPT [ملف]', ['-n: منع الطباعة الافتراضية','s/old/new/: استبدال نمط','-i: تعديل الملف مباشرة (بحذر)'], "sed -n '1,10p' notes.txt يعرض أول عشرة أسطر.", 'تنظيف النصوص وتحويلها ضمن سكربتات الأتمتة.', 'اختبر النتيجة دون -i أولاً؛ التعديل المباشر قد يغيّر الملف الأصلي.'],
    awk: ['لغة لمعالجة النصوص كسجلات وحقول، وتدعم شروطاً وحسابات بسيطة.', 'awk [خيارات] PROGRAM [ملف]', ['-F: تحديد فاصل الحقول','BEGIN: تنفيذ تهيئة قبل السجلات','END: تنفيذ ملخص بعد السجلات'], "awk -F: '{print $1}' /etc/passwd يستخرج العمود الأول.", 'تحليل ملفات سجلات وجداول نصية واستخراج إحصاءات.', 'تختلف الحقول حسب الفاصل؛ لا تفترض أن كل النصوص مفصولة بمسافة واحدة.'],
    tee: ['يقرأ من الإدخال القياسي ويكتب نسخة إلى الشاشة وإلى ملف أو أكثر.', 'tee [خيارات] ملف...', ['-a: الإضافة بدلاً من الاستبدال','-i: تجاهل إشارات المقاطعة'], 'استخدم tee output.txt لتسجيل ناتج تدريب في ملف ضمن نظام حقيقي.', 'حفظ مخرجات أمر مع استمرار عرضها.', 'قد يستبدل الملف عند عدم استخدام -a؛ تحقق من الوجهة.'],
    lsblk: ['يعرض أجهزة الكتل وأقسامها ونقاط التركيب على شكل شجرة.', 'lsblk [خيارات]', ['-f: أنظمة الملفات والمعرّفات ونقاط التركيب','-o: اختيار الأعمدة','-p: المسارات الكاملة'], 'lsblk -f يساعد على فهم الأقراص والأقسام المركبة.', 'استكشاف التخزين قبل تركيب قرص أو تشخيص مساحة.', 'لا تنفذ عمليات تهيئة أو تقسيم بناءً على اسم جهاز غير متأكد منه.'],
    mount: ['يربط نظام ملفات بمجلد موجود ضمن شجرة الملفات.', 'mount [خيارات] DEVICE DIRECTORY', ['-t: نوع نظام الملفات','-o: خيارات التركيب','بدون وسائط: عرض أنظمة الملفات المركبة'], 'mount يعرض الأنظمة المركبة؛ التركيب الفعلي يتطلب جهازاً ومساراً مناسبين.', 'الوصول إلى أقسام الأقراص ووسائط التخزين.', 'تركيب جهاز خاطئ أو خيارات غير مناسبة قد يعرض البيانات للخطر.'],
    umount: ['يفصل نظام ملفات عن نقطة التركيب بعد التحقق من عدم استخدام الملفات المفتوحة.', 'umount DEVICE_OR_DIRECTORY', ['-l: فصل كسول في حالات خاصة','-f: فرض الفصل في حالات محدودة'], 'افحص الاستخدام قبل فصل وسيط تخزين.', 'إزالة أقراص خارجية أو فصل أنظمة ملفات مؤقتة.', 'لا تفصل قرصاً أثناء الكتابة؛ فقد تفقد بيانات لم تُفرغ إلى التخزين.'],
    top: ['يعرض العمليات واستهلاك المعالج والذاكرة بشكل متجدد.', 'top [خيارات]', ['-u USER: تصفية مستخدم','-p PID: متابعة عملية محددة','q: الخروج من الواجهة التفاعلية'], 'top يتيح ملاحظة العمليات الأكثر استهلاكاً للموارد.', 'تشخيص بطء النظام والبحث عن عملية تستهلك CPU أو الذاكرة.', 'القيم لحظية وتتغير؛ راقب الاتجاه وليس لقطة واحدة فقط.'],
    git: ['نظام لإدارة إصدارات الملفات؛ يسجل التغييرات في مستودع ويمكنه إنشاء فروع ودمجها.', 'git COMMAND [خيارات]', ['status: حالة الملفات','add: تجهيز التغييرات','commit: تسجيل لقطة','log: عرض السجل','branch: إدارة الفروع'], 'git status يعرض الملفات المعدلة وغير المتتبعة في المستودع.', 'تتبع تاريخ الشيفرة والعمل التعاوني ومراجعة التغييرات.', 'لا تضع كلمات مرور أو مفاتيح API في المستودع؛ استخدم .gitignore وأدر الأسرار خارج Git.'],
    crontab: ['يدير جدول المهام المجدولة للمستخدم باستخدام صيغة زمنية من خمسة حقول.', 'crontab [خيارات]', ['-e: تحرير جدول المستخدم','-l: عرض الجدول','-r: إزالة الجدول بالكامل'], 'crontab -l يعرض المهام المجدولة للمستخدم الحالي.', 'أتمتة النسخ الاحتياطي والتنظيف والفحوص الدورية.', 'افهم صيغة الوقت والبيئة المحدودة للمهام؛ -r يحذف كل الجدول.'],
    gzip: ['يضغط الملفات بخوارزمية gzip لتقليل حجم التخزين أو النقل.', 'gzip [خيارات] ملف', ['-d: فك الضغط','-k: الاحتفاظ بالملف الأصلي','-c: الكتابة إلى المخرجات القياسية'], 'gzip -k archive.log ينشئ نسخة مضغوطة ويحتفظ بالأصل.', 'ضغط ملفات السجلات والنسخ الاحتياطية.', 'الضغط ليس تشفيراً؛ لا تستخدمه لحماية سرية البيانات.'],
    hostname: ['يعرض أو يضبط اسم المضيف الذي يعرّف النظام على الشبكة.', 'hostname [خيارات]', ['-f: اسم النطاق الكامل عند توفره','-I: عناوين IP للمضيف'], 'hostname يعرض اسم الجهاز الحالي.', 'تمييز الخوادم في الشبكات وسجلات الإدارة.', 'تغيير الاسم قد يؤثر في خدمات أو إعدادات تعتمد عليه؛ افحص DNS وملفات الإعداد.'],
    file: ['يحاول تحديد نوع الملف من محتواه وتوقيعاته، لا من امتداده فقط.', 'file [خيارات] FILE', ['-i: نوع MIME','-L: اتباع الروابط الرمزية'], 'file download.bin يساعد على معرفة نوع ملف مجهول.', 'فحص الملفات قبل فتحها أو معالجتها.', 'التعرّف على النوع ليس فحصاً أمنياً كاملاً ولا يثبت أن الملف آمن.'],
    stat: ['يعرض بيانات وصفية تفصيلية عن ملف أو نظام ملفات، مثل الحجم والأذونات والطوابع الزمنية.', 'stat [خيارات] FILE', ['-c: تنسيق مخصص','-f: معلومات نظام الملفات'], 'stat report.txt يعرض بيانات الملف.', 'تشخيص صلاحيات الملفات ووقت التعديل والحجم.', 'قد تختلف دلالات أوقات access/modify/change، فلا تخلط بينها.']
  };

  function renderCommandDeepDive(item) {
    const base = item.command.trim().split(/\s+/)[0].split('/').pop();
    const info = commandKnowledge[base];
    const sections = info ? [
      ['كيف يعمل؟', info[0]], ['الصيغة العامة', info[1]], ['الخيارات المهمة', info[2].length ? `<ul>${info[2].map(x=>`<li>${escapeHTML(x)}</li>`).join('')}</ul>` : 'هذا الأمر لا يحتاج عادةً إلى خيارات في الاستخدام الأساسي.'],
      ['مثال عملي', info[3] + `<code class="deep-dive-example">${escapeHTML(item.command)}</code>`], ['متى نستخدمه؟', info[4]], ['أخطاء وتحذيرات', info[5]]
    ] : [
      ['كيف يعمل؟', `الأمر جزء من أدوات Linux. ${escapeHTML(item.description)}. يقرأ الوسائط التي تكتبها الصدفة ثم ينفذ الوظيفة التي يوفرها البرنامج أو الأمر الداخلي.`],
      ['الصيغة العامة', `${escapeHTML(base)} [خيارات] [وسائط]`],
      ['الخيارات والوسائط', `حلّل كل خيار في المثال التالي، وارجع إلى صفحة الدليل المحلية باستخدام man ${escapeHTML(base)} في نظام Linux حقيقي لمعرفة كل الخيارات المدعومة.`],
      ['مثال عملي', `ابدأ بالمثال الموجود في الموسوعة، ثم غيّر وسيطاً واحداً في كل مرة ولاحظ الفرق.` + `<code class="deep-dive-example">${escapeHTML(item.command)}</code>`],
      ['متى نستخدمه؟', `يُستخدم عندما تحتاج المهمة الموضّحة في تعريف الأمر: ${escapeHTML(item.description)}.`],
      ['أخطاء وتحذيرات', 'تحقق من تهجئة الأمر والمسار والصلاحيات ونوع الوسائط. لا تستخدم خيارات حذف أو تعديل واسعة قبل فهم تأثيرها.']
    ];
    const extra = [
      ['فكّر في السبب', `ما المشكلة التي يحلها ${escapeHTML(base)}؟ وما المعلومات التي يحتاجها من المستخدم أو النظام كي ينفذها؟`],
      ['تحدّي تطبيقي', `نفّذ المثال في مختبر الطرفية إن كان مدعوماً، ثم اشرح بكلماتك ماذا تغيّر أو ما الذي أظهره الأمر.`]
    ];
    $('commandDeepDive').innerHTML = [...sections, ...extra].map(([title,body]) => `<section class="deep-dive-section"><h3>${title}</h3><div>${typeof body === 'string' ? body : body}</div></section>`).join('');
  }

  function getPracticeExample(item) {
    const base = item.command.trim().split(/\s+/)[0].split('/').pop();
    const safe = { pwd:'pwd', ls:'ls -la', cd:'cd Documents', mkdir:'mkdir practice_folder', touch:'touch practice.txt', cp:'cp Documents/notes.txt practice-copy.txt', mv:'mv practice-copy.txt practice-renamed.txt', cat:'cat Documents/notes.txt', whoami:'whoami', id:'id', uname:'uname -a', date:'date', echo:'echo Hello Linux', tree:'tree' };
    return safe[base] || item.command;
  }

  function renderCommandWorkspace(item) {
    const example = getPracticeExample(item);
    $('lessonTerminalOutput').innerHTML = '<p class="terminal-muted">مساحة تدريب افتراضية لهذا الدرس. التغييرات هنا لا تؤثر على ملفات حقيقية.</p>';
    $('lessonTerminalInput').value = example;
    const base = item.command.trim().split(/\s+/)[0].split('/').pop();
    const pythonLesson = ['python','python3','pip'].includes(base);
    $('lessonCodeLanguage').value = pythonLesson ? 'python' : 'bash';
    $('lessonCodeEditor').value = pythonLesson ? 'message = \"Hello Linux!\"\nprint(message)' : `${example.startsWith('echo') ? example : 'pwd\nls\necho Lesson practice'}`;
    $('lessonCodeOutput').textContent = 'عدّل المثال ثم اضغط تشغيل المثال.';
  }

  function openCommand(id) {
    const item = commands.find((c) => c.id === id);
    if (!item) return;
    activeCommand = item;
    $('modalCategory').textContent = `${item.category} · COMMAND REFERENCE`;
    $('modalCommand').textContent = item.command;
    $('modalDescription').textContent = item.description;
    $('modalCode').textContent = item.command;
    $('modalLevel').textContent = `المستوى: ${LABELS[item.level]}`;
    $('modalId').textContent = `رقم الأمر: ${item.id}`;
    $('markCommandDone').textContent = profile.completed.includes(id) ? 'إزالة من الأوامر المتعلّمة' : 'تحديد كمتعلّم ✓';
    renderCommandDeepDive(item);
    renderCommandWorkspace(item);
    $('commandModal').classList.remove('hidden');
  }

  function closeCommand() { $('commandModal').classList.add('hidden'); activeCommand = null; }
  function toggleCommandDone() {
    if (!activeCommand) return;
    const id = activeCommand.id;
    const nowCompleted = !profile.completed.includes(id);
    if (nowCompleted) profile.completed.push(id);
    else profile.completed = profile.completed.filter((n) => n !== id);
    persistCommandProgress(id, nowCompleted);
    saveProfile();
    $('markCommandDone').textContent = profile.completed.includes(id) ? 'إزالة من الأوامر المتعلّمة' : 'تحديد كمتعلّم ✓';
    renderDashboard(); renderLibrary(); renderAchievements(); renderProfile();
    toast(profile.completed.includes(id) ? 'تمت إضافة الأمر إلى سجل تعلمك' : 'تمت إزالة الأمر من سجل تعلمك');
  }

  const quizBank = {
    beginner: [
      { q: 'أي أمر يعرض المسار الحالي الذي تعمل بداخله؟', options: ['ls', 'pwd', 'whoami', 'cd'], a: 1 },
      { q: 'أي أمر يعرض الملفات المخفية مع التفاصيل؟', options: ['ls -la', 'touch', 'clear', 'echo'], a: 0 },
      { q: 'ما وظيفة الأمر cp؟', options: ['حذف ملف', 'نسخ ملف أو مجلد', 'تغيير الصلاحيات', 'عرض الوقت'], a: 1 },
      { q: 'أي أمر يعرض محتويات ملف نصي؟', options: ['mkdir', 'mv', 'cat', 'rmdir'], a: 2 },
      { q: 'أي أمر يعرض مساحة أنظمة الملفات؟', options: ['df -h', 'who', 'date', 'pwd'], a: 0 }
    ],
    intermediate: [
      { q: 'ما وظيفة chmod؟', options: ['تغيير صلاحيات الملفات', 'تغيير اسم المضيف', 'عرض العمليات', 'ضغط الملفات'], a: 0 },
      { q: 'أي أمر يعرض منافذ TCP وUDP المستمعة؟', options: ['free -h', 'ss -tuln', 'lsblk', 'whoami'], a: 1 },
      { q: 'ما وظيفة journalctl -b؟', options: ['عرض سجلات الإقلاع الحالي', 'إعادة تشغيل النظام', 'حذف السجلات', 'عرض الأقراص'], a: 0 },
      { q: 'ما الذي يفعله grep -i؟', options: ['يعكس الملف', 'يتجاهل حالة الأحرف أثناء البحث', 'يحذف النتائج', 'يبحث عن الملفات الكبيرة'], a: 1 },
      { q: 'أي أمر يضيف مستخدمًا إلى مجموعة دون إزالة مجموعاته الأخرى؟', options: ['userdel', 'groupdel', 'usermod -aG', 'passwd -d'], a: 2 }
    ],
    advanced: [
      { q: 'ما وظيفة strace -p PID؟', options: ['ضغط الذاكرة', 'تتبع استدعاءات النظام لعملية', 'إنشاء مستخدم', 'عرض مساحة القرص'], a: 1 },
      { q: 'ما الغرض من sysctl؟', options: ['إدارة إعدادات النواة القابلة للضبط', 'إدارة صور Docker', 'تحرير النصوص', 'تغيير كلمة المرور'], a: 0 },
      { q: 'ما الخيار الآمن لفحص إعدادات logrotate دون تطبيقها؟', options: ['-f', '-d', '-v فقط', '-r'], a: 1 },
      { q: 'ما وظيفة kill -STOP؟', options: ['استئناف عملية', 'تعليق عملية مؤقتًا', 'حذف العملية نهائيًا', 'تغيير أولوية العملية'], a: 1 },
      { q: 'أي أمر يعرض سلسلة الوحدات المؤثرة في وقت الإقلاع؟', options: ['systemd-analyze critical-chain', 'systemctl reboot', 'uptime -p', 'ps aux'], a: 0 }
    ]
  };

  function renderQuizzes() {
    const meta = [
      { level: 'beginner', title: 'اختبار المبتدئ', desc: 'أساسيات الطرفية والملفات وأوامر النظام.', icon: '01' },
      { level: 'intermediate', title: 'اختبار المتوسط', desc: 'الصلاحيات والعمليات والخدمات والشبكات.', icon: '02' },
      { level: 'advanced', title: 'اختبار المتقدم', desc: 'التشخيص وإدارة النظام ومفاهيم الأمن.', icon: '03' }
    ];
    $('quizLevelGrid').innerHTML = meta.map((m) => {
      const unlocked = levelUnlocked(m.level);
      const passed = profile.passed.includes(m.level);
      const score = profile.quizScores[m.level];
      return `<article class="quiz-level-card ${unlocked ? '' : 'locked'}"><span class="roadmap-number">LEVEL ${m.icon}</span><h3>${m.title}</h3><p>${m.desc}</p><div class="roadmap-status"><span>${passed ? `أفضل نتيجة: ${score}%` : unlocked ? '5 أسئلة · النجاح من 80%' : '🔒 غير متاح بعد'}</span><b>${passed ? '✓ مجتاز' : unlocked ? 'جاهز' : 'مقفل'}</b></div><button class="button ${unlocked ? 'button-primary' : 'button-outline'}" data-start-quiz="${m.level}" ${unlocked ? '' : 'disabled'}>${unlocked ? 'ابدأ الاختبار' : 'أكمل المتطلبات أولًا'}</button></article>`;
    }).join('');
    $('quizLevelGrid').querySelectorAll('[data-start-quiz]').forEach((button) => button.addEventListener('click', () => startQuiz(button.dataset.startQuiz)));
    const showGate = profile.passed.includes('beginner') && !telegramVerified;
    $('telegramGate').classList.toggle('hidden', !showGate);
    $('quizStage').classList.add('hidden');
  }

  function startQuiz(level) {
    if (!levelUnlocked(level)) { toast('هذا الاختبار مقفل حتى تستوفي متطلباته.'); return; }
    quizState = { level, index: 0, selected: null, answers: [], finished: false };
    $('quizStage').classList.remove('hidden');
    renderQuizQuestion();
    $('quizStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderQuizQuestion() {
    const qset = quizBank[quizState.level];
    const q = qset[quizState.index];
    const n = quizState.index + 1;
    $('quizStage').innerHTML = `<div class="panel-head"><div><span class="eyebrow">${LABELS[quizState.level].toUpperCase()} ASSESSMENT</span><h3>السؤال ${n} من ${qset.length}</h3></div><button class="text-button" id="exitQuiz">إنهاء الاختبار</button></div><div class="quiz-progress"><span style="width:${(n / qset.length) * 100}%"></span></div><h2 class="quiz-question">${q.q}</h2><div class="quiz-options">${q.options.map((option, i) => `<button class="quiz-option ${quizState.selected === i ? 'selected' : ''}" data-answer="${i}">${escapeHTML(option)}</button>`).join('')}</div><div class="quiz-actions"><small>اختر إجابة واحدة ثم تابع.</small><button class="button button-primary" id="nextQuestion" ${quizState.selected === null ? 'disabled' : ''}>${n === qset.length ? 'إنهاء الاختبار' : 'السؤال التالي ←'}</button></div>`;
    $('quizStage').querySelectorAll('[data-answer]').forEach((button) => button.addEventListener('click', () => {
      quizState.selected = Number(button.dataset.answer);
      renderQuizQuestion();
    }));
    $('nextQuestion').addEventListener('click', advanceQuiz);
    $('exitQuiz').addEventListener('click', () => { quizState = null; $('quizStage').classList.add('hidden'); });
  }

  function advanceQuiz() {
    if (quizState.selected === null) return;
    quizState.answers.push(quizState.selected);
    if (quizState.index < quizBank[quizState.level].length - 1) {
      quizState.index += 1; quizState.selected = null; renderQuizQuestion(); return;
    }
    finishQuiz();
  }

  async function finishQuiz() {
    const level = quizState.level;
    const questions = quizBank[level];
    const answers = [...quizState.answers];
    const correctLocal = questions.reduce((sum, q, i) => sum + (q.a === answers[i] ? 1 : 0), 0);
    $('quizStage').innerHTML = '<div class="quiz-result"><p>جارٍ تصحيح الاختبار وحفظ النتيجة بشكل آمن...</p></div>';
    let score;
    try {
      const { data, error } = await supabaseClient.functions.invoke('telegram-gateway', {
        body: { action: 'submit-quiz', quiz_id: level, answers }
      });
      if (error) throw error;
      score = Number(data.score);
    } catch (error) {
      console.error('Quiz submission failed:', error);
      $('quizStage').innerHTML = '<div class="quiz-result"><h3>تعذر حفظ نتيجة الاختبار</h3><p>تأكد من نشر وظيفة الخادم وتشغيل ملف SQL. لم نسجل نتيجة غير موثوقة من المتصفح.</p><button class="button button-primary" id="retryQuizSubmit">إعادة المحاولة</button></div>';
      $('retryQuizSubmit').addEventListener('click', () => finishQuiz());
      return;
    }
    const passed = score >= 80;
    profile.quizAttempts[level] = (profile.quizAttempts[level] || 0) + 1;
    profile.quizScores[level] = Math.max(profile.quizScores[level] || 0, score);
    if (passed && !profile.passed.includes(level)) profile.passed.push(level);
    const summary = { level, score, correct: Math.round(score / 100 * questions.length), total: questions.length };
    $('quizStage').innerHTML = `<div class="quiz-result"><span class="eyebrow">ASSESSMENT RESULT</span><h3>${passed ? 'أحسنت! اجتزت الاختبار.' : 'تحتاج إلى مراجعة بعض المفاهيم.'}</h3><p>أجبت عن ${summary.correct} من ${summary.total} إجابات صحيحة.</p><strong>${score}%</strong><p>${passed ? 'تم حفظ نتيجة اجتيازك في حسابك.' : 'تحتاج إلى 80% على الأقل. راجع الدروس وحاول مرة أخرى.'}</p><div class="quiz-actions"><button class="button button-outline" id="reviewQuiz">عرض الاختبارات</button><button class="button button-primary" id="retryQuiz">${passed ? 'إعادة الاختبار' : 'حاول مرة أخرى'}</button></div></div>`;
    $('reviewQuiz').addEventListener('click', () => { quizState = null; renderQuizzes(); });
    $('retryQuiz').addEventListener('click', () => startQuiz(level));
    renderDashboard(); renderPaths(); renderQuizzes(); renderAchievements(); renderProfile();
    $('quizStage').classList.remove('hidden');
    toast(passed ? 'تم اجتياز الاختبار وحفظ النتيجة' : 'لم تصل إلى درجة النجاح بعد');
    quizState = { level, index: 0, selected: null, answers: [], finished: true };
  }

  function renderAchievements() {
    const items = [
      { icon: '⌘', title: 'بداية الرحلة', desc: 'تعلّم أول أمر Linux.', done: profile.completed.length >= 1 },
      { icon: '▤', title: 'جامع الأوامر', desc: 'تعلّم 25 أمرًا.', done: profile.completed.length >= 25 },
      { icon: '⚡', title: 'متعلّم نشط', desc: 'تعلّم 100 أمر.', done: profile.completed.length >= 100 },
      { icon: '✓', title: 'اختبار المبتدئ', desc: 'اجتز اختبار المستوى الأول.', done: profile.passed.includes('beginner') },
      { icon: '◇', title: 'مستوى متوسط', desc: 'اجتز اختبار المستوى المتوسط.', done: profile.passed.includes('intermediate') },
      { icon: '⬡', title: 'متقدم', desc: 'اجتز اختبار المستوى المتقدم.', done: profile.passed.includes('advanced') },
      { icon: '✦', title: 'متقن', desc: 'تعلّم 500 أمر.', done: profile.completed.length >= 500 },
      { icon: '★', title: 'موسوعي', desc: 'أكمل جميع الأوامر الـ1500.', done: profile.completed.length >= 1500 }
    ];
    $('achievementGrid').innerHTML = items.map((item) => `<article class="achievement-card ${item.done ? '' : 'locked'}"><div class="achievement-icon">${item.icon}</div><b>${item.title}</b><small>${item.desc}</small><small class="done-mark">${item.done ? 'تم الحصول عليها ✓' : 'لم تُفتح بعد'}</small></article>`).join('');
  }

  function renderProfile() {
    $('profileCommands').textContent = profile.completed.length.toLocaleString('en-US');
    $('profileQuizzes').textContent = profile.passed.length.toLocaleString('en-US');
    $('profileLevel').textContent = LABELS[getCurrentLevel()];
  }

  function addTerminalLine(text, className = '', outputId = 'terminalOutput') {
    const container = $(outputId);
    if (!container) return;
    const line = document.createElement('p');
    if (className) line.className = className;
    line.textContent = text;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  function normaliseVirtualPath(path) {
    if (path === '~') return '/home/learner';
    if (path.startsWith('~/')) path = '/home/learner/' + path.slice(2);
    const parts = (path.startsWith('/') ? path : `${terminalCwd}/${path}`).split('/');
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop(); else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  function virtualChildren(path) {
    const prefix = path === '/' ? '/' : path + '/';
    const items = new Map();
    for (const dir of virtualDirectories) {
      if (dir === path || !dir.startsWith(prefix)) continue;
      const remainder = dir.slice(prefix.length);
      if (remainder && !remainder.includes('/')) items.set(remainder, true);
    }
    for (const file of virtualFiles.keys()) {
      if (!file.startsWith(prefix)) continue;
      const remainder = file.slice(prefix.length);
      if (remainder && !remainder.includes('/')) items.set(remainder, false);
    }
    return [...items.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  }

  function simulateCommandResult(raw) {
    const cmd = raw.trim();
    if (!cmd) return '';
    if (/[;&|`$<>]/.test(cmd)) return 'تم رفض رموز توصيل الأوامر أو إعادة التوجيه في هذه المحاكاة الآمنة.';
    const args = cmd.match(/"[^"]*"|'[^']*'|\S+/g)?.map(x => x.replace(/^['"]|['"]$/g,'')) || [];
    const op = args.shift();
    const arg = args.filter(x => !x.startsWith('-'));
    const target = arg[0] || '';
    switch (op) {
      case 'help': return 'الأوامر المتاحة: pwd, ls, cd, mkdir, rmdir, touch, cat, cp, mv, rm, tree, whoami, id, uname, date, echo, clear, history, help';
      case 'pwd': return terminalCwd;
      case 'whoami': return currentUser || 'learner';
      case 'id': return 'uid=1000(learner) gid=1000(learner) groups=1000(learner)';
      case 'uname': return 'Linux linux-ar 6.8.0-training x86_64 GNU/Linux';
      case 'date': return new Date().toString();
      case 'echo': return args.join(' ');
      case 'ls': {
        const path = target ? normaliseVirtualPath(target) : terminalCwd;
        if (!virtualDirectories.has(path) && !virtualFiles.has(path)) return `ls: لا يوجد مسار بهذا الاسم: ${target}`;
        if (virtualFiles.has(path)) return path.split('/').pop();
        return virtualChildren(path).map(([name,isDir]) => isDir ? name + '/' : name).join('  ') || '(المجلد فارغ)';
      }
      case 'cd': {
        const path = target ? normaliseVirtualPath(target) : '/home/learner';
        if (!virtualDirectories.has(path)) return `cd: لا يوجد مجلد: ${target || path}`;
        terminalCwd = path; return '';
      }
      case 'mkdir': {
        if (!target) return 'mkdir: اكتب اسم المجلد.';
        const path = normaliseVirtualPath(target);
        if (virtualDirectories.has(path) || virtualFiles.has(path)) return `mkdir: المسار موجود بالفعل: ${target}`;
        if (args.includes('-p')) {
          const chunks = path.split('/').filter(Boolean); let current = '';
          for (const chunk of chunks) { current += '/' + chunk; virtualDirectories.add(current); }
          return '';
        }
        const parent = path.slice(0,path.lastIndexOf('/')) || '/';
        if (!virtualDirectories.has(parent)) return `mkdir: المجلد الأب غير موجود: ${parent}`;
        virtualDirectories.add(path); return '';
      }
      case 'touch': {
        if (!target) return 'touch: اكتب اسم ملف.';
        const path = normaliseVirtualPath(target);
        const parent = path.slice(0,path.lastIndexOf('/')) || '/';
        if (!virtualDirectories.has(parent)) return `touch: المجلد الأب غير موجود: ${parent}`;
        if (!virtualFiles.has(path)) virtualFiles.set(path,''); return '';
      }
      case 'cat': {
        if (!target) return 'cat: اكتب اسم الملف.';
        const path = normaliseVirtualPath(target);
        return virtualFiles.has(path) ? virtualFiles.get(path) : `cat: لا يوجد ملف بهذا الاسم: ${target}`;
      }
      case 'rm': {
        if (!target) return 'rm: اكتب اسم الملف.';
        const path = normaliseVirtualPath(target);
        if (virtualFiles.delete(path)) return '';
        if (virtualDirectories.has(path)) return 'هذه محاكاة، ولا نحذف المجلدات باستخدام rm في هذا التدريب؛ استخدم rmdir للمجلد الفارغ.';
        return `rm: لا يوجد ملف بهذا الاسم: ${target}`;
      }
      case 'rmdir': {
        const path = normaliseVirtualPath(target);
        if (!virtualDirectories.has(path) || path === '/' || path === '/home/learner') return 'rmdir: المجلد غير موجود أو محمي.';
        if (virtualChildren(path).length) return 'rmdir: المجلد غير فارغ.';
        virtualDirectories.delete(path); return '';
      }
      case 'cp': case 'mv': {
        if (arg.length < 2) return `${op}: الصيغة: ${op} source destination`;
        const src = normaliseVirtualPath(arg[0]), dst = normaliseVirtualPath(arg[1]);
        if (!virtualFiles.has(src)) return `${op}: المصدر غير موجود أو ليس ملفاً.`;
        const parent = dst.slice(0,dst.lastIndexOf('/')) || '/';
        if (!virtualDirectories.has(parent)) return `${op}: المجلد الهدف غير موجود.`;
        virtualFiles.set(dst, virtualFiles.get(src)); if (op === 'mv') virtualFiles.delete(src); return '';
      }
      case 'tree': return `${terminalCwd}\n├── Documents/\n│   └── notes.txt\n├── Downloads/\n└── projects/\n    └── README.md`;
      case 'clear': return '__CLEAR__';
      case 'history': return terminalHistory.join('\n') || '(لا يوجد سجل بعد)';
      default: return `الأمر غير متاح في المحاكاة: ${op}. لم يتم تنفيذ أي أمر فعلي. اكتب help للأوامر المدعومة.`;
    }
  }

  function runSimulatedCommand(raw, outputId = 'terminalOutput') {
    const cmd = raw.trim();
    if (!cmd) return;
    terminalHistory.push(cmd);
    addTerminalLine(`learner@linux-ar:${terminalCwd.replace('/home/learner','~')}$ ${cmd}`, '', outputId);
    const result = simulateCommandResult(cmd);
    if (result === '__CLEAR__') $(outputId).innerHTML = '';
    else if (result) addTerminalLine(result, result.startsWith('الأمر غير متاح') || result.includes('لا يوجد') ? 'terminal-muted' : '', outputId);
  }

  function runCodeSample(editorId = 'codeEditor', languageId = 'codeLanguage', outputId = 'codeOutput') {
    const language = $(languageId).value;
    const source = $(editorId).value;
    const output = [];
    if (source.length > 8000) { $(outputId).textContent = 'حجم المثال أكبر من الحد التدريبي (8000 حرف).'; return; }
    if (language === 'python') {
      const vars = {};
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const assignment = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
        if (assignment) {
          const value = assignment[2].trim();
          if (/^(['"]).*\1$/.test(value)) vars[assignment[1]] = value.slice(1,-1);
          else if (/^-?\d+(?:\.\d+)?$/.test(value)) vars[assignment[1]] = Number(value);
          else { output.push(`SyntaxError: لا يدعم المشغّل هذا التعبير: ${value}`); continue; }
          continue;
        }
        const print = line.match(/^print\((.*)\)$/);
        if (print) {
          const expression = print[1].trim();
          if (/^(['"]).*\1$/.test(expression)) output.push(expression.slice(1,-1));
          else if (Object.prototype.hasOwnProperty.call(vars, expression)) output.push(String(vars[expression]));
          else if (/^-?\d+(?:\.\d+)?$/.test(expression)) output.push(expression);
          else output.push(`NameError أو تعبير غير مدعوم: ${expression}`);
          continue;
        }
        output.push(`تم تخطي السطر غير المدعوم في وضع التدريب: ${line}`);
      }
    } else {
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const result = simulateCommandResult(line);
        output.push(result === '__CLEAR__' ? '' : result || '(تم تنفيذ الأمر داخل المحاكاة)');
      }
    }
    $(outputId).textContent = output.join('\n') || '(لم ينتج المثال أي مخرجات)';
  }

  function bindEvents() {
    document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
    $('authForm').addEventListener('submit', handleAuthSubmit);
    $('logoutButton').addEventListener('click', leaveApp);
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
    document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
    $('themeToggle').addEventListener('click', () => {
      document.body.classList.toggle('light');
      localStorage.setItem('linuxArTheme', document.body.classList.contains('light') ? 'light' : 'dark');
    });
    if (localStorage.getItem('linuxArTheme') === 'light') document.body.classList.add('light');
    $('mobileMenu').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    $('commandSearch').addEventListener('input', () => { page = 1; renderLibrary(); });
    $('levelFilter').addEventListener('change', () => { page = 1; renderLibrary(); });
    $('categoryFilter').addEventListener('change', () => { page = 1; renderLibrary(); });
    $('closeCommandModal').addEventListener('click', closeCommand);
    $('commandModal').addEventListener('click', (event) => { if (event.target === $('commandModal')) closeCommand(); });
    $('markCommandDone').addEventListener('click', toggleCommandDone);
    $('copyCommand').addEventListener('click', async () => {
      if (!activeCommand) return;
      try { await navigator.clipboard.writeText(activeCommand.command); toast('تم نسخ الأمر'); }
      catch { toast('تعذر النسخ؛ حدد الأمر وانسخه يدويًا.'); }
    });
    $('practiceCommand').addEventListener('click', () => {
      if (!activeCommand) return;
      const example = getPracticeExample(activeCommand);
      $('terminalInput').value = example;
      closeCommand(); navigate('lab'); $('terminalInput').focus();
    });
    $('terminalForm').addEventListener('submit', (event) => { event.preventDefault(); runSimulatedCommand($('terminalInput').value); $('terminalInput').value = ''; });
    $('lessonTerminalForm').addEventListener('submit', (event) => { event.preventDefault(); runSimulatedCommand($('lessonTerminalInput').value, 'lessonTerminalOutput'); $('lessonTerminalInput').value = ''; });
    $('runLessonCode').addEventListener('click', () => runCodeSample('lessonCodeEditor','lessonCodeLanguage','lessonCodeOutput'));
    $('resetLessonCode').addEventListener('click', () => { $('lessonCodeLanguage').value='python'; $('lessonCodeEditor').value='print(\"Hello Linux!\")'; $('lessonCodeOutput').textContent='تمت استعادة المثال.'; });
    $('lessonCodeLanguage').addEventListener('change', () => { $('lessonCodeEditor').value = $('lessonCodeLanguage').value === 'python' ? 'print(\"Hello Linux!\")' : 'pwd\nls\necho Hello Linux'; $('lessonCodeOutput').textContent='اختر المثال ثم اضغط تشغيل المثال.'; });
    document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => { $('terminalInput').value = button.dataset.command; $('terminalInput').focus(); }));
    $('runCodeDemo').addEventListener('click', runCodeSample);
    $('resetCode').addEventListener('click', () => {
      $('codeLanguage').value = 'python'; $('codeEditor').value = 'print("Hello Linux!")'; $('codeOutput').textContent = 'تمت استعادة المثال.';
    });
    $('codeLanguage').addEventListener('change', () => {
      $('codeEditor').value = $('codeLanguage').value === 'python' ? 'print("Hello Linux!")' : 'pwd\nls\necho Hello Linux';
      $('codeOutput').textContent = 'اختر المثال ثم اضغط تشغيل تجريبي.';
    });
    document.querySelectorAll('[data-challenge]').forEach((button) => button.addEventListener('click', () => {
      const correct = button.dataset.challenge === 'pwd';
      $('challengeFeedback').textContent = correct ? 'إجابة صحيحة — pwd يعرض المسار الحالي.' : 'ليست الإجابة الصحيحة. جرّب pwd.';
      $('challengeFeedback').style.color = correct ? 'var(--green)' : 'var(--amber)';
      if (correct && !profile.challengeDone) { profile.challengeDone = true; saveProfile(); }
    }));
    $('createTelegramLink').addEventListener('click', createTelegramLink);
    $('verifyTelegram').addEventListener('click', () => refreshTelegramStatus(true));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeCommand();
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && currentView === 'library') {
        event.preventDefault(); $('commandSearch').focus();
      }
      if (event.key === 'Enter' && event.target === $('terminalInput')) { /* form handles execution */ }
    });
  }

  async function boot() {
    bindEvents();
    setAuthMode('login');
    if (!supabaseClient) {
      $('authError').textContent = 'إعداد Supabase غير مكتمل. افتح config.js وتأكد من العنوان والمفتاح العام.';
    }
    await loadCommands();
    if (supabaseClient) {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) console.warn(error);
      if (data?.session?.user) await enterApp(data.session.user);
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && authUser) {
          authUser = null; currentUser = ''; telegramVerified = false; profile = emptyProfile();
          $('appShell').classList.add('hidden'); $('authScreen').classList.remove('hidden');
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
