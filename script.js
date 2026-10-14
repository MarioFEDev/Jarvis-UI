/* ==========================================================================
   J.A.R.V.I.S. interface — script.js
   Modules (all vanilla, no dependencies):
     Config · Utils · Store/Conversations/Settings · MockProvider (swappable AI)
     Markdown · ChatView (rendering only) · Toasts · Tooltip · Panels
     Sidebar · Composer · App (controller that wires everything together)

   To plug in a real AI backend, replace `provider` near the bottom with any
   object exposing:  label, model, async *stream({ messages, signal, speed })
   which yields text chunks. Nothing else needs to change.
   ========================================================================== */
(() => {
  'use strict';

  /* ---------------------------------------------------------------- Config */
  const CONFIG = {
    keys: { conversations: 'jarvis.conversations.v1', settings: 'jarvis.settings.v1' },
    maxConversations: 50,
    maxAttachments: 5,
    maxRecent: 6,
    mobileQuery: '(max-width: 820px)',
    bootDelay: 650,
    speeds: {
      fast: { chunk: 14, think: 350 },
      normal: { chunk: 30, think: 850 },
      slow: { chunk: 60, think: 1500 },
    },
    states: {
      booting: { short: 'Initializing', long: 'Initializing' },
      idle: { short: 'Online', long: 'Online · Ready' },
      listening: { short: 'Listening', long: 'Listening' },
      processing: { short: 'Thinking', long: 'Processing request' },
      responding: { short: 'Responding', long: 'Generating response' },
    },
    announce: {
      processing: 'JARVIS is thinking.',
      responding: 'JARVIS is responding.',
    },
  };

  /* ----------------------------------------------------------------- Utils */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const abortError = () => new DOMException('Aborted', 'AbortError');
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => { clearTimeout(t); reject(abortError()); };
      const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  const motionOff = () =>
    document.documentElement.dataset.motion === 'reduced' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const timeAgo = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'Just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 172800) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const greetingForHour = (h) => (h >= 5 && h < 12 ? 'Good morning.' : h >= 12 && h < 18 ? 'Good afternoon.' : 'Good evening.');

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  /* --------------------------------------------------- Storage & settings */
  const Store = {
    read(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
      catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };

  const Settings = {
    data: { speed: 'normal', reduceMotion: false, sidebar: 'open' },
    load() { Object.assign(this.data, Store.read(CONFIG.keys.settings, {})); },
    set(patch) { Object.assign(this.data, patch); Store.write(CONFIG.keys.settings, this.data); },
    apply() {
      if (this.data.reduceMotion) document.documentElement.dataset.motion = 'reduced';
      else delete document.documentElement.dataset.motion;
    },
  };

  const Conversations = {
    list: [],
    load() {
      const raw = Store.read(CONFIG.keys.conversations, []);
      this.list = Array.isArray(raw) ? raw.filter((c) => c && c.id && Array.isArray(c.messages)) : [];
    },
    save() {
      this.list = this.sorted().slice(0, CONFIG.maxConversations);
      return Store.write(CONFIG.keys.conversations, this.list);
    },
    sorted() { return [...this.list].sort((a, b) => b.updatedAt - a.updatedAt); },
    get(id) { return this.list.find((c) => c.id === id) || null; },
    create() {
      const now = Date.now();
      const conv = { id: uid(), title: 'New conversation', createdAt: now, updatedAt: now, messages: [] };
      this.list.push(conv);
      return conv;
    },
    remove(id) {
      const conv = this.get(id);
      this.list = this.list.filter((c) => c.id !== id);
      this.save();
      return conv;
    },
    restore(conv) { if (conv && !this.get(conv.id)) { this.list.push(conv); this.save(); } },
    clear() { this.list = []; this.save(); },
    stats() {
      return { conversations: this.list.length, messages: this.list.reduce((n, c) => n + c.messages.length, 0) };
    },
  };

  /* ---------------------------------------------------------- Mock provider
     A deliberately simple intent matcher. Replace with a real API client by
     implementing the same `stream()` signature.                             */
  const FENCE = '```';
  const KNOWLEDGE = [
    {
      test: /^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i,
      reply: () => 'Hello, and welcome back. All systems are running and I\'m ready to help.\n\nYou can ask me a question, request some code, have a concept explained, or brainstorm ideas together. Where would you like to start?',
    },
    {
      test: /thank/i,
      reply: () => 'Happy to help. If you want to go further, I can **expand on any point**, simplify it, or turn it into a concrete next step.',
    },
    {
      test: /who are you|what are you|your name/i,
      reply: () => 'I\'m **J.A.R.V.I.S.**, a demo assistant interface.\n\nRight now I\'m powered by a **mock response engine**, not a real language model. The interface, streaming behaviour and conversation storage are all real, so a live AI API can be dropped in later without changing the UI.',
    },
    {
      test: /what('s| is)?\s+(the\s+)?(current\s+)?time|time is it/i,
      reply: () => `The local time is **${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}**.\n\nThis answer is read from your device clock.`,
    },
    {
      test: /what('s| is)?\s+(the\s+)?(date|day)|today'?s date/i,
      reply: () => `Today is **${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}**.`,
    },
    {
      test: /sky.*blue|sunset|why is the sky/i,
      reply: () => 'The sky is blue because of **Rayleigh scattering**.\n\nSunlight contains every colour. As it passes through the atmosphere, air molecules scatter short wavelengths (blue and violet) far more strongly than long ones (red and orange). That scattered blue light reaches your eyes from every direction.\n\n### Why sunsets turn orange\n- At sunset, light travels through much more atmosphere to reach you.\n- Most of the blue is scattered out of the beam along the way.\n- What remains is dominated by **orange and red**.\n\nViolet scatters even more than blue, but the sun emits less of it and our eyes are less sensitive to it, so the sky looks blue.',
    },
    {
      test: /debounce/i,
      reply: () => `Here's a compact, dependency-free debounce:\n\n${FENCE}js\nfunction debounce(fn, wait = 300) {\n  let timer;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), wait);\n  };\n}\n\n// Usage\nconst onResize = debounce(() => {\n  console.log('Resized to', window.innerWidth);\n}, 250);\n\nwindow.addEventListener('resize', onResize);\n${FENCE}\n\n**How it works**\n- Every call cancels the pending timer and starts a new one.\n- \`fn\` only runs after calls have stopped for \`wait\` milliseconds.\n- \`this\` and arguments are forwarded to the original function.\n\nIf you need the first call to fire immediately, I can add a \`leading\` option.`,
    },
    {
      test: /neural network/i,
      reply: () => 'A neural network learns by **adjusting numbers until its guesses improve**.\n\n1. **Guess:** input data flows through layers of simple units, each multiplying values by *weights* and passing them on.\n2. **Measure:** a loss function scores how wrong the output was.\n3. **Blame:** backpropagation works out how much each weight contributed to the error.\n4. **Nudge:** gradient descent shifts every weight slightly in the direction that reduces the error.\n5. **Repeat:** over thousands of examples, useful patterns emerge.\n\nThink of it as tuning millions of tiny dials, where each pass makes the whole system a little less wrong.',
    },
    {
      test: /brainstorm|ideas?\b/i,
      reply: () => 'Here are five directions to start from:\n\n1. **Ambient routines:** a hub that learns your habits and adjusts lighting, heating and music without commands.\n2. **Energy coach:** real-time insight into which devices cost the most, with one-tap savings suggestions.\n3. **Household memory:** a shared, searchable log of "where did we put that?" and recurring chores.\n4. **Privacy-first voice:** an assistant that processes everything on-device and shows what it heard.\n5. **Guest mode:** temporary, limited access for visitors, expiring automatically.\n\nTell me which one resonates and I\'ll sketch features, risks and a first prototype.',
    },
    {
      test: /what can you do|capabilit|help me|\bhelp\b/i,
      reply: () => 'I can help in four main ways:\n\n- **Answer questions** across science, history, technology and more.\n- **Write and review code** in most popular languages.\n- **Explain concepts** step by step, at the level you choose.\n- **Brainstorm** names, plans, strategies and creative ideas.\n\nIn this demo, responses come from a mock engine, so treat them as examples of the experience.',
    },
  ];

  const MockProvider = {
    label: 'Mock Engine',
    model: 'jarvis-mock-1',

    /** Pick a reply for the latest user message. */
    compose(messages) {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const text = (last?.content || '').trim();
      const files = last?.attachments || [];
      const hit = KNOWLEDGE.find((k) => k.test.test(text));
      let reply;
      if (hit) reply = hit.reply({ text });
      else {
        const topic = text.length > 90 ? `${text.slice(0, 90).trim()}…` : text;
        reply = topic
          ? `You asked: *"${topic}"*\n\nThis demo runs on a **mock response engine**, so I can't produce a real answer, but here is how I'd approach it:\n\n1. Clarify the goal and any constraints.\n2. Break the problem into smaller parts.\n3. Work through each part, checking assumptions.\n4. Summarise the result and suggest next steps.\n\nTry one of the suggestion cards on the welcome screen for a fuller example response.`
          : 'I received your attachment. Tell me what you\'d like to do with it.';
      }
      if (files.length) {
        reply += `\n\n**Attachments received:** ${files.map((f) => `\`${f.name}\``).join(', ')}. In demo mode I can't read file contents, but a connected model could analyse them.`;
      }
      return reply;
    },

    /** Async generator yielding text chunks, like a streaming API would. */
    async *stream({ messages, signal, speed = 'normal' }) {
      const timing = CONFIG.speeds[speed] || CONFIG.speeds.normal;
      await sleep(timing.think * (0.8 + Math.random() * 0.5), signal);
      const reply = this.compose(messages);
      const parts = reply.match(/\S+\s*|\n+/g) || [reply];
      for (let i = 0; i < parts.length; i += 2) {
        if (signal?.aborted) throw abortError();
        yield parts.slice(i, i + 2).join('');
        await sleep(timing.chunk * (0.6 + Math.random() * 0.8), signal);
      }
    },
  };

  /* -------------------------------------------------------------- Markdown */
  const KEYWORDS = /\b(function|return|const|let|var|if|else|for|while|new|class|import|export|from|async|await|try|catch|throw|this|def|in|of|true|false|null|undefined)\b/;
  const TOKEN_RE = new RegExp(
    [
      '(\\/\\/.*|\\/\\*[\\s\\S]*?\\*\\/|#.*)',          // 1 comment
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // 2 string
      '(\\b\\d+(?:\\.\\d+)?\\b)',                      // 3 number
      `(${KEYWORDS.source})`,                           // 4 keyword (nested group 5)
      '(\\b[A-Za-z_$][\\w$]*(?=\\())',                  // 6 function call
    ].join('|'),
    'g'
  );

  function highlight(code) {
    let out = '', last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(code))) {
      out += escapeHtml(code.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'k' : 'f';
      out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
      last = m.index + m[0].length;
      if (m[0].length === 0) TOKEN_RE.lastIndex++;
    }
    return out + escapeHtml(code.slice(last));
  }

  function inline(text) {
    return text
      .split(/(`[^`]+`)/)
      .map((part) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        return escapeHtml(part)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
      })
      .join('');
  }

  /** Safe, minimal markdown: fenced code, headings, lists, paragraphs, inline code/bold/italic. */
  function renderMarkdown(src) {
    const codes = [];
    const text = src.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
      codes.push({ lang, code: code.replace(/\n$/, '') });
      return `\n\n\u0000${codes.length - 1}\u0000\n\n`;
    });
    return text
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .map((block) => {
        const ph = block.match(/^\u0000(\d+)\u0000$/);
        if (ph) {
          const { lang, code } = codes[+ph[1]];
          return `<div class="code"><div class="code__head"><span>${escapeHtml(lang || 'code')}</span><button type="button" class="icon-btn" data-action="copy-code" aria-label="Copy code" data-tooltip="Copy code">${icon('copy')}</button></div><pre><code>${highlight(code)}</code></pre></div>`;
        }
        const heading = block.match(/^(#{1,4})\s+(.*)$/);
        if (heading) return `<h3>${inline(heading[2])}</h3>`;
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
        if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
        return `<p>${lines.map(inline).join('<br>')}</p>`;
      })
      .join('');
  }

  /* -------------------------------------------------------------- ChatView
     Pure rendering: knows nothing about providers, storage or app state.     */
  const ChatView = {
    el: $('#thread'),

    renderMessage(msg) {
      const el = document.createElement('article');
      el.className = `msg msg--${msg.role}`;
      el.dataset.id = msg.id;
      const time = `<time datetime="${new Date(msg.createdAt).toISOString()}">${formatTime(msg.createdAt)}</time>`;
      if (msg.role === 'user') {
        const files = (msg.attachments || []).length
          ? `<div class="msg__files">${msg.attachments.map((f) => `<span class="chip">${icon('file')}<span class="chip__name">${escapeHtml(f.name)}</span></span>`).join('')}</div>`
          : '';
        el.innerHTML = `<div class="msg__main"><div class="msg__meta">${time}</div>${files}${msg.content ? '<div class="msg__bubble"></div>' : ''}</div>`;
        const bubble = $('.msg__bubble', el);
        if (bubble) bubble.textContent = msg.content;
      } else {
        el.innerHTML = `<div class="msg__avatar"></div><div class="msg__main"><div class="msg__meta"><span class="msg__author">JARVIS</span>${time}</div><div class="msg__bubble prose"></div><div class="msg__actions"><button type="button" class="icon-btn" data-action="copy-message" aria-label="Copy response" data-tooltip="Copy">${icon('copy')}</button><button type="button" class="icon-btn" data-action="regenerate" aria-label="Regenerate response" data-tooltip="Regenerate">${icon('refresh')}</button></div></div>`;
        $('.msg__avatar', el).append($('#orb-template').content.cloneNode(true));
        this.update(el, msg.content || '');
      }
      return el;
    },

    renderTyping() {
      const el = this.renderMessage({ id: 'typing', role: 'assistant', content: '', createdAt: Date.now() });
      el.classList.add('is-typing');
      $('.msg__bubble', el).innerHTML = '<span class="typing" role="status" aria-label="JARVIS is typing"><span></span><span></span><span></span></span>';
      return el;
    },

    update(el, content) { $('.msg__bubble', el).innerHTML = renderMarkdown(content); },

    setNote(el, text) {
      $('.msg__note', el)?.remove();
      if (text) $('.msg__main', el).append(Object.assign(document.createElement('p'), { className: 'msg__note', textContent: text }));
    },

    markLast() {
      $$('.msg.is-last', this.el).forEach((n) => n.classList.remove('is-last'));
      const all = $$('.msg--assistant:not(.is-typing)', this.el);
      const lastMsg = $$('.msg', this.el).pop();
      if (lastMsg && lastMsg.classList.contains('msg--assistant') && !lastMsg.classList.contains('is-typing')) lastMsg.classList.add('is-last');
      return all;
    },

    clear() { this.el.replaceChildren(); },
  };

  /* ---------------------------------------------------------------- Toasts */
  const Toasts = {
    region: $('#toast-region'),
    show(message, { actionLabel, onAction, duration = 4000 } = {}) {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.append(Object.assign(document.createElement('span'), { textContent: message }));
      const dismiss = () => {
        if (!toast.isConnected) return;
        toast.classList.add('is-leaving');
        setTimeout(() => {
          toast.remove();
          if (!this.region.children.length) { try { this.region.hidePopover(); } catch { /* ignore */ } }
        }, motionOff() ? 0 : 250);
      };
      if (actionLabel) {
        const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'toast__action', textContent: actionLabel });
        btn.addEventListener('click', () => { onAction?.(); dismiss(); });
        toast.append(btn);
      }
      this.region.append(toast);
      try { if (!this.region.matches(':popover-open')) this.region.showPopover(); } catch { /* ignore */ }
      setTimeout(dismiss, duration);
    },
  };

  /* --------------------------------------------------------------- Tooltip */
  const Tooltip = {
    el: $('#tooltip'),
    timer: 0,
    init() {
      document.addEventListener('pointerover', (e) => {
        if (e.pointerType === 'touch') return;
        const t = e.target.closest?.('[data-tooltip]');
        if (t) this.schedule(t, 350);
      });
      document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tooltip]')) this.hide(); });
      document.addEventListener('focusin', (e) => {
        const t = e.target.closest?.('[data-tooltip]');
        if (t && t.matches(':focus-visible')) this.schedule(t, 0);
      });
      document.addEventListener('focusout', () => this.hide());
      document.addEventListener('pointerdown', () => this.hide());
      window.addEventListener('scroll', () => this.hide(), true);
    },
    schedule(target, delay) {
      this.hide();
      this.timer = setTimeout(() => this.show(target), delay);
    },
    show(target) {
      const inSidebar = !!target.closest('#sidebar');
      if (inSidebar && (Sidebar.isMobile() || Sidebar.state() !== 'collapsed')) return;
      const tip = this.el;
      tip.textContent = target.dataset.tooltip;
      tip.hidden = false;
      const r = target.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let x, y;
      if (inSidebar) { x = r.right + 10; y = r.top + (r.height - t.height) / 2; }
      else if (target.closest('.composer-wrap')) { x = r.left + (r.width - t.width) / 2; y = r.top - t.height - 8; }
      else { x = r.left + (r.width - t.width) / 2; y = r.bottom + 8; }
      tip.style.left = `${clamp(x, 8, innerWidth - t.width - 8)}px`;
      tip.style.top = `${clamp(y, 8, innerHeight - t.height - 8)}px`;
      requestAnimationFrame(() => tip.classList.add('is-visible'));
    },
    hide() {
      clearTimeout(this.timer);
      this.el.classList.remove('is-visible');
      this.el.hidden = true;
    },
  };

  /* --------------------------------------------------------------- Sidebar */
  const Sidebar = {
    app: $('#app'),
    el: $('#sidebar'),
    toggle: $('#sidebar-toggle'),
    mq: window.matchMedia(CONFIG.mobileQuery),
    isMobile() { return this.mq.matches; },
    state() { return this.app.dataset.sidebar; },

    set(state, { persist = true, focus = false } = {}) {
      const open = state === 'open';
      this.app.dataset.sidebar = state;
      this.toggle.setAttribute('aria-expanded', String(open));
      const label = open ? 'Collapse sidebar' : 'Expand sidebar';
      this.toggle.setAttribute('aria-label', label);
      this.toggle.dataset.tooltip = label;
      $('#backdrop').setAttribute('aria-hidden', String(!(open && this.isMobile())));
      // Keep the offscreen drawer out of the tab order.
      this.el.inert = this.isMobile() && !open;
      if (persist && !this.isMobile()) Settings.set({ sidebar: state });
      if (focus && this.isMobile()) (open ? $('.sidebar__close', this.el) : this.toggle).focus({ preventScroll: true });
    },
    open(opts) { this.set('open', opts); },
    close(opts) { this.set('collapsed', opts); },
    flip() { this.set(this.state() === 'open' ? 'collapsed' : 'open', { focus: true }); },

    init() {
      this.set(this.isMobile() ? 'collapsed' : Settings.data.sidebar === 'collapsed' ? 'collapsed' : 'open', { persist: false });
      this.toggle.addEventListener('click', () => this.flip());
      $('#backdrop').addEventListener('click', () => this.close({ focus: true }));
      this.mq.addEventListener('change', () => {
        this.set(this.isMobile() ? 'collapsed' : Settings.data.sidebar === 'collapsed' ? 'collapsed' : 'open', { persist: false });
      });
    },
  };

  /* -------------------------------------------------------------- Composer */
  const Composer = {
    form: $('#composer'),
    input: $('#composer-input'),
    send: $('#send-btn'),
    fileInput: $('#file-input'),
    chips: $('#attachments'),
    files: [],
    busy: false,
    handlers: {},

    init(handlers) {
      this.handlers = handlers;
      $('#composer-hint').innerHTML = '<kbd>Enter</kbd> send <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> new line <span aria-hidden="true">·</span> <kbd>/</kbd> focus';

      this.input.addEventListener('input', () => this.sync());
      this.input.addEventListener('focus', () => handlers.onFocus(true));
      this.input.addEventListener('blur', () => handlers.onFocus(false));
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.form.requestSubmit(); }
      });
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (this.busy) return handlers.onStop();
        handlers.onSubmit(this.input.value.trim(), [...this.files]);
      });
      $('#attach-btn').addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', () => { this.addFiles(this.fileInput.files); this.fileInput.value = ''; });
      this.chips.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (btn) { this.files.splice(+btn.dataset.remove, 1); this.renderChips(); this.sync(); this.input.focus(); }
      });

      ['dragenter', 'dragover'].forEach((t) => this.form.addEventListener(t, (e) => { e.preventDefault(); this.form.classList.add('is-dragover'); }));
      ['dragleave', 'drop'].forEach((t) => this.form.addEventListener(t, (e) => { e.preventDefault(); this.form.classList.remove('is-dragover'); }));
      this.form.addEventListener('drop', (e) => this.addFiles(e.dataTransfer?.files || []));
      this.sync();
    },

    addFiles(list) {
      for (const f of list) {
        if (this.files.length >= CONFIG.maxAttachments) { Toasts.show(`You can attach up to ${CONFIG.maxAttachments} files.`); break; }
        this.files.push({ name: f.name, size: f.size });
      }
      this.renderChips();
      this.sync();
    },
    renderChips() {
      this.chips.hidden = !this.files.length;
      this.chips.innerHTML = this.files
        .map((f, i) => `<span class="chip">${icon('file')}<span class="chip__name">${escapeHtml(f.name)}</span><span class="chip__size">${formatBytes(f.size)}</span><button type="button" class="chip__remove" data-remove="${i}" aria-label="Remove ${escapeHtml(f.name)}">${icon('x')}</button></span>`)
        .join('');
    },

    /** Auto-grow textarea and update send button state. */
    sync() {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 200)}px`;
      const valid = this.input.value.trim().length > 0 || this.files.length > 0;
      this.send.disabled = !valid && !this.busy;
      this.send.dataset.mode = this.busy ? 'stop' : 'send';
      const label = this.busy ? 'Stop generating' : 'Send message';
      this.send.setAttribute('aria-label', label);
      this.send.dataset.tooltip = this.busy ? 'Stop' : 'Send';
      this.handlers.onInput?.(this.input.value);
    },
    setBusy(busy) { this.busy = busy; this.sync(); },
    setValue(v) { this.input.value = v; this.sync(); },
    reset() { this.input.value = ''; this.files = []; this.renderChips(); this.sync(); },
    focus() { this.input.focus({ preventScroll: true }); },
  };

  /* ---------------------------------------------------------------- Panels */
  const Panels = {
    dialog: $('#panel'),
    body: $('#panel-body'),
    kind: null,
    timer: 0,
    query: '',

    defs: {
      history: { title: 'Conversation history', icon: 'history' },
      capabilities: { title: 'Explore capabilities', icon: 'compass' },
      system: { title: 'System information', icon: 'cpu' },
      settings: { title: 'Settings', icon: 'sliders' },
    },

    init() {
      this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
      this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) this.close(); });
      this.body.addEventListener('input', (e) => {
        if (e.target.matches('[data-role="history-search"]')) { this.query = e.target.value; this.renderHistoryList(); }
      });
    },

    open(kind) {
      clearTimeout(this.timer);
      this.dialog.classList.remove('is-closing');
      this.kind = kind;
      this.query = '';
      const def = this.defs[kind];
      $('#panel-title').textContent = def.title;
      $('#panel-icon').innerHTML = icon(def.icon);
      this.render();
      if (!this.dialog.open) this.dialog.showModal();
      clearInterval(this.tick);
      if (kind === 'system') this.tick = setInterval(() => this.updateUptime(), 1000);
    },

    close() {
      if (!this.dialog.open) return;
      clearInterval(this.tick);
      this.dialog.classList.add('is-closing');
      this.timer = setTimeout(() => { this.dialog.close(); this.dialog.classList.remove('is-closing'); this.kind = null; }, motionOff() ? 0 : 200);
    },

    render() {
      const k = this.kind;
      if (k === 'history') {
        this.body.innerHTML = `<label class="p-search">${icon('search')}<input type="search" placeholder="Search conversations" aria-label="Search conversations" data-role="history-search" autocomplete="off" autofocus></label><ul class="p-list" role="list" data-role="history-list"></ul>`;
        this.renderHistoryList();
      } else if (k === 'capabilities') {
        this.body.innerHTML = `<p class="panel__lead">Select a capability to try it. Responses come from the demo engine.</p><div class="cap-grid">${CAPABILITIES.map((c) => `<button type="button" class="cap" data-action="use-prompt" data-prompt="${escapeHtml(c.prompt)}">${icon(c.icon)}<span class="cap__title">${c.title}</span><span class="cap__desc">${c.desc}</span></button>`).join('')}</div>`;
      } else if (k === 'system') {
        this.body.innerHTML = `<dl class="info" data-role="system-info"></dl>`;
        this.renderSystem();
      } else if (k === 'settings') {
        const s = Settings.data;
        const osReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.body.innerHTML = `
          <div class="setting"><div class="setting__text"><span class="setting__title" id="set-speed">Response speed</span><span class="setting__desc">How quickly simulated replies stream in.</span></div>
            <div class="segmented" role="radiogroup" aria-labelledby="set-speed">${['fast', 'normal', 'slow'].map((v) => `<button type="button" role="radio" aria-checked="${s.speed === v}" data-action="set-speed" data-value="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div>
          <div class="setting"><div class="setting__text"><span class="setting__title" id="set-motion">Reduce motion</span><span class="setting__desc">${osReduced ? 'Your system already requests reduced motion.' : 'Calms the orb and disables most animation.'}</span></div>
            <button type="button" class="switch" role="switch" aria-labelledby="set-motion" aria-checked="${s.reduceMotion}" data-action="toggle-motion"></button></div>
          <div class="setting"><div class="setting__text"><span class="setting__title">Clear conversations</span><span class="setting__desc">Removes all saved chats from this browser.</span></div>
            <button type="button" class="btn btn--danger" data-action="clear-all">${icon('trash')}<span>Clear all</span></button></div>`;
      }
    },

    renderHistoryList() {
      const q = this.query.trim().toLowerCase();
      const items = Conversations.sorted().filter((c) => !q || c.title.toLowerCase().includes(q));
      $('[data-role="history-list"]', this.body).innerHTML = items.length
        ? items.map((c) => `<li class="p-item"><button type="button" class="p-item__main" data-action="open-conversation" data-id="${c.id}"><span class="p-item__title">${escapeHtml(c.title)}</span><span class="p-item__meta">${c.messages.length} messages · ${timeAgo(c.updatedAt)}</span></button><button type="button" class="icon-btn" data-action="delete-conversation" data-id="${c.id}" aria-label="Delete conversation: ${escapeHtml(c.title)}">${icon('trash')}</button></li>`).join('')
        : `<li class="p-empty">${q ? 'No conversations match your search.' : 'No saved conversations yet. Start a chat and it will appear here.'}</li>`;
    },

    renderSystem() {
      const stats = Conversations.stats();
      const size = (JSON.stringify(Conversations.list).length / 1024).toFixed(1);
      const rows = [
        ['AI core', CONFIG.states[document.body.dataset.aiState]?.long || '—'],
        ['Connection', navigator.onLine ? 'Secure' : 'Offline'],
        ['Model', provider.label],
        ['Engine ID', provider.model],
        ['Session uptime', '<span data-role="uptime"></span>'],
        ['Conversations', stats.conversations],
        ['Messages stored', stats.messages],
        ['Local storage', `${size} KB`],
        ['Viewport', `${innerWidth} × ${innerHeight}`],
        ['Motion', motionOff() ? 'Reduced' : 'Full'],
      ];
      $('[data-role="system-info"]', this.body).innerHTML = rows.map(([k, v]) => `<div class="info__row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
      this.updateUptime();
    },
    updateUptime() {
      const el = $('[data-role="uptime"]', this.body);
      if (!el) return;
      const s = Math.floor((Date.now() - App.startedAt) / 1000);
      el.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    },
  };

  const CAPABILITIES = [
    { icon: 'help', title: 'Answer questions', desc: 'Clear, reasoned answers on almost any topic.', prompt: 'Why is the sky blue, and why do sunsets look orange?' },
    { icon: 'code', title: 'Write code', desc: 'Generate, review and refactor code.', prompt: 'Write a JavaScript debounce function with a short usage example.' },
    { icon: 'book', title: 'Explain concepts', desc: 'Complex ideas in simple, intuitive terms.', prompt: 'Explain how neural networks learn, in simple terms.' },
    { icon: 'bulb', title: 'Brainstorm ideas', desc: 'Names, plans and creative directions.', prompt: 'Brainstorm five product ideas for a smart home assistant.' },
    { icon: 'layers', title: 'Summarise & compare', desc: 'Distil long topics into key trade-offs.', prompt: 'What can you do?' },
    { icon: 'clock', title: 'Quick facts', desc: 'Time, date and everyday lookups.', prompt: 'What is the date today?' },
  ];

  /* ------------------------------------------------------------------- App */
  const provider = MockProvider; // <- swap for a real AI provider here

  const App = {
    startedAt: Date.now(),
    conv: null,
    busy: false,
    controller: null,
    composerFocused: false,
    view: 'welcome',
    stick: true,
    viewToken: 0,

    stage: $('#stage'),
    main: $('#main'),
    welcome: $('#welcome'),
    thread: $('#thread'),

    /* ----- AI state (drives orb animation, labels, announcements) ----- */
    setAI(state) {
      if (document.body.dataset.aiState === state) return;
      document.body.dataset.aiState = state;
      const s = CONFIG.states[state];
      $$('[data-ai-label]').forEach((el) => { el.textContent = s[el.dataset.aiLabel] || s.short; });
      if (CONFIG.announce[state]) $('#sr-status').textContent = CONFIG.announce[state];
    },
    settleAI() { if (!this.busy) this.setAI(this.composerFocused ? 'listening' : 'idle'); },

    /* ----- View switching (welcome <-> chat) ----- */
    showView(view) {
      const token = ++this.viewToken;
      const swapIn = (el) => {
        el.hidden = false;
        if (el === this.thread) { el.classList.remove('is-entering'); void el.offsetWidth; el.classList.add('is-entering'); this.scrollToBottom(false); }
      };
      this.main.dataset.view = view;
      if (view === this.view) {
        if (view === 'chat') swapIn(this.thread);
        return;
      }
      this.view = view;
      const out = view === 'chat' ? this.welcome : this.thread;
      const into = view === 'chat' ? this.thread : this.welcome;
      const finish = () => {
        if (token !== this.viewToken) return;
        out.hidden = true; out.classList.remove('is-leaving');
        swapIn(into);
        if (view === 'welcome') this.stage.scrollTop = 0;
      };
      if (motionOff()) return finish();
      out.classList.add('is-leaving');
      setTimeout(finish, 260);
    },

    scrollToBottom(smooth = true) {
      requestAnimationFrame(() => this.stage.scrollTo({ top: this.stage.scrollHeight, behavior: smooth && !motionOff() ? 'smooth' : 'auto' }));
    },

    setTitle(text) {
      $('#conversation-title').textContent = text;
      document.title = text === 'New conversation' ? 'JARVIS · Intelligent Assistant' : `${text} · JARVIS`;
    },

    updateGreeting() { $('#greeting-time').textContent = greetingForHour(new Date().getHours()); },

    /* ----- Sidebar recent list ----- */
    renderRecent() {
      const items = Conversations.sorted().slice(0, CONFIG.maxRecent);
      $('#recent-list').innerHTML = items.length
        ? items.map((c) => {
            const active = c.id === this.conv?.id;
            return `<li class="recent-item${active ? ' is-active' : ''}"><button type="button" class="recent-item__btn" data-action="open-conversation" data-id="${c.id}"${active ? ' aria-current="true"' : ''}>${icon('message')}<span class="recent-item__text label"><span class="recent-item__title">${escapeHtml(c.title)}</span><span class="recent-item__time">${timeAgo(c.updatedAt)}</span></span></button><button type="button" class="recent-item__del" data-action="delete-conversation" data-id="${c.id}" aria-label="Delete conversation: ${escapeHtml(c.title)}">${icon('trash')}</button></li>`;
          }).join('')
        : '<li class="recent-empty label">Your conversations will appear here.</li>';
    },

    /* ----- Conversation lifecycle ----- */
    newChat({ focus = true } = {}) {
      this.abort();
      this.conv = null;
      this.updateGreeting();
      this.setTitle('New conversation');
      Composer.reset();
      this.showView('welcome');
      this.thread.replaceChildren();
      this.renderRecent();
      this.settleAI();
      if (focus && !Sidebar.isMobile()) Composer.focus();
    },

    openConversation(id) {
      const conv = Conversations.get(id);
      if (!conv) return;
      this.abort();
      this.conv = conv;
      ChatView.clear();
      conv.messages.forEach((m) => this.thread.append(ChatView.renderMessage(m)));
      ChatView.markLast();
      this.setTitle(conv.title);
      this.showView('chat');
      this.renderRecent();
      this.settleAI();
    },

    deleteConversation(id) {
      const removed = Conversations.remove(id);
      if (!removed) return;
      if (this.conv?.id === id) this.newChat({ focus: false });
      else this.renderRecent();
      if (Panels.kind === 'history') Panels.renderHistoryList();
      Toasts.show('Conversation deleted.', { actionLabel: 'Undo', onAction: () => { Conversations.restore(removed); this.renderRecent(); if (Panels.kind === 'history') Panels.renderHistoryList(); } });
    },

    /* ----- Sending & streaming ----- */
    submit(text, attachments = []) {
      if (this.busy || (!text && !attachments.length)) return;
      if (!this.conv) this.conv = Conversations.create();
      const msg = { id: uid(), role: 'user', content: text, attachments, createdAt: Date.now() };
      this.conv.messages.push(msg);
      this.conv.updatedAt = Date.now();
      if (this.conv.messages.length === 1) {
        const base = text || attachments[0]?.name || 'New conversation';
        this.conv.title = base.length > 44 ? `${base.slice(0, 44).trim()}…` : base;
      }
      Conversations.save();
      this.setTitle(this.conv.title);
      this.thread.append(ChatView.renderMessage(msg));
      ChatView.markLast();
      this.showView('chat');
      this.stick = true;
      this.scrollToBottom();
      Composer.reset();
      this.renderRecent();
      this.generate();
    },

    async generate() {
      const conv = this.conv;
      this.busy = true;
      Composer.setBusy(true);
      this.setAI('processing');
      this.controller = new AbortController();
      const { signal } = this.controller;

      const typingEl = ChatView.renderTyping();
      this.thread.append(typingEl);
      this.stick = true;
      this.scrollToBottom();

      let el = typingEl, text = '';
      try {
        for await (const chunk of provider.stream({ messages: conv.messages.slice(), signal, speed: Settings.data.speed })) {
          if (el === typingEl) {
            el.classList.remove('is-typing');
            el.classList.add('is-streaming');
            this.setAI('responding');
          }
          text += chunk;
          ChatView.update(el, text);
          if (this.stick) this.stage.scrollTop = this.stage.scrollHeight;
        }
        this.finishMessage(conv, el, text, false);
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
          this.finishMessage(conv, el, text || 'Something went wrong while generating a response.', false);
          Toasts.show('The assistant ran into a problem. Please try again.');
        } else {
          this.finishMessage(conv, el, text, true);
        }
      } finally {
        this.busy = false;
        this.controller = null;
        Composer.setBusy(false);
        // Give the "responding" glow a moment to settle before idling.
        this.setAI('responding');
        setTimeout(() => this.settleAI(), motionOff() ? 0 : 900);
      }
    },

    finishMessage(conv, el, text, stopped) {
      el.classList.remove('is-typing', 'is-streaming');
      if (!text) { el.remove(); ChatView.markLast(); return; }
      el.dataset.id = uid();
      if (stopped) ChatView.setNote(el, 'Response stopped');
      conv.messages.push({ id: el.dataset.id, role: 'assistant', content: text, createdAt: Date.now(), stopped });
      conv.updatedAt = Date.now();
      Conversations.save();
      ChatView.markLast();
      this.renderRecent();
      if (!stopped) $('#sr-status').textContent = 'Response complete.';
    },

    abort() { this.controller?.abort(); },

    regenerate() {
      if (this.busy || !this.conv) return;
      const msgs = this.conv.messages;
      if (msgs.at(-1)?.role !== 'assistant') return;
      msgs.pop();
      $$('.msg--assistant', this.thread).pop()?.remove();
      Conversations.save();
      this.generate();
    },

    /* ----- Global click delegation ----- */
    async onAction(btn, e) {
      const a = btn.dataset.action;
      if (btn.closest('#sidebar') && Sidebar.isMobile() && a !== 'close-sidebar' && a !== 'delete-conversation') Sidebar.close({ persist: false });

      switch (a) {
        case 'close-sidebar': Sidebar.close({ focus: true }); break;
        case 'new-chat': this.newChat(); break;
        case 'open-history': Panels.open('history'); break;
        case 'open-capabilities': Panels.open('capabilities'); break;
        case 'open-system': Panels.open('system'); break;
        case 'open-settings': Panels.open('settings'); break;
        case 'close-panel': Panels.close(); break;
        case 'suggestion': this.submit(btn.dataset.prompt); break;
        case 'use-prompt': Panels.close(); this.submit(btn.dataset.prompt); break;
        case 'open-conversation': Panels.close(); this.openConversation(btn.dataset.id); break;
        case 'delete-conversation': this.deleteConversation(btn.dataset.id); break;
        case 'regenerate': this.regenerate(); break;
        case 'copy-message': {
          const id = btn.closest('.msg')?.dataset.id;
          const m = this.conv?.messages.find((x) => x.id === id);
          this.flashCopied(btn, await copyText(m?.content || $('.msg__bubble', btn.closest('.msg')).textContent));
          break;
        }
        case 'copy-code':
          this.flashCopied(btn, await copyText($('code', btn.closest('.code')).textContent));
          break;
        case 'set-speed':
          Settings.set({ speed: btn.dataset.value });
          $$('[data-action="set-speed"]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
          break;
        case 'toggle-motion':
          Settings.set({ reduceMotion: !Settings.data.reduceMotion });
          Settings.apply();
          btn.setAttribute('aria-checked', String(Settings.data.reduceMotion));
          break;
        case 'clear-all':
          if (!btn.classList.contains('is-armed')) {
            btn.classList.add('is-armed');
            $('span', btn).textContent = 'Click to confirm';
            setTimeout(() => { btn.classList.remove('is-armed'); $('span', btn).textContent = 'Clear all'; }, 3000);
          } else {
            Conversations.clear();
            this.newChat({ focus: false });
            Panels.close();
            Toasts.show('All conversations cleared.');
          }
          break;
      }
    },

    flashCopied(btn, ok) {
      const original = btn.innerHTML;
      btn.innerHTML = icon(ok ? 'check' : 'x');
      btn.classList.add('is-done');
      if (!ok) Toasts.show('Copy failed. Your browser blocked clipboard access.');
      setTimeout(() => { btn.innerHTML = original; btn.classList.remove('is-done'); }, 1400);
    },

    /* ----- Setup ----- */
    bindEvents() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (btn) this.onAction(btn, e);
      });

      // Pointer-following glow on suggestion cards
      $('#suggestions').addEventListener('pointermove', (e) => {
        const card = e.target.closest('.card');
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });

      // Subtle hero orb parallax
      const hero = $('.orb--hero');
      let raf = 0;
      document.addEventListener('pointermove', (e) => {
        if (raf || motionOff() || this.view !== 'welcome' || e.pointerType === 'touch') return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          hero.style.setProperty('--px', `${((e.clientX / innerWidth) - 0.5) * 14}px`);
          hero.style.setProperty('--py', `${((e.clientY / innerHeight) - 0.5) * 10}px`);
        });
      });

      this.stage.addEventListener('scroll', () => {
        this.stick = this.stage.scrollHeight - this.stage.scrollTop - this.stage.clientHeight < 80;
      }, { passive: true });

      document.addEventListener('keydown', (e) => {
        const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
        if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !Panels.dialog.open) { e.preventDefault(); Composer.focus(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); Sidebar.flip(); }
        else if (e.key === 'Escape' && !Panels.dialog.open) {
          if (Sidebar.isMobile() && Sidebar.state() === 'open') Sidebar.close({ focus: true });
          else if (this.busy) this.abort();
        }
      });

      // Connection state
      const updateConn = () => {
        const online = navigator.onLine;
        $('#conn-label').textContent = online ? 'Secure' : 'Offline';
        $('#conn-dot').className = `status-dot${online ? '' : ' is-offline'}`;
      };
      window.addEventListener('online', () => { updateConn(); Toasts.show('Connection restored.'); });
      window.addEventListener('offline', () => { updateConn(); Toasts.show('You are offline. The demo engine still works.'); });
      updateConn();
    },

    init() {
      document.documentElement.classList.add('no-anim');
      Settings.load(); Settings.apply();
      Conversations.load();
      $$('[data-model-label]').forEach((el) => { el.textContent = provider.label; });
      this.updateGreeting();
      this.renderRecent();
      Tooltip.init();
      Panels.init();
      Sidebar.init();
      Composer.init({
        onSubmit: (text, files) => this.submit(text, files),
        onStop: () => this.abort(),
        onFocus: (focused) => { this.composerFocused = focused; this.settleAI(); },
      });
      this.bindEvents();
      this.setAI('booting');
      requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-anim')));

      // Boot sequence: brief initialisation, then reveal the welcome screen.
      setTimeout(() => {
        document.body.classList.remove('is-booting');
        this.setAI('idle');
        if (!Sidebar.isMobile()) Composer.focus();
      }, motionOff() ? 0 : CONFIG.bootDelay);
    },
  };

  App.init();
})();
