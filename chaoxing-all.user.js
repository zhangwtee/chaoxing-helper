// ==UserScript==
// @name         学习通助手（刷课+做题+AI）
// @namespace    local.chaoxing.allin1
// @version      2.0.0
// @description  单面板：刷视频任务点 / 测验字体解密 / AI 或题库填答；不自动提交
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @require      https://cdn.jsdelivr.net/gh/photopea/Typr.js/src/Typr.js
// @require      https://cdn.jsdelivr.net/gh/photopea/Typr.js/src/Typr.U.js
// @require      https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js
// @resource     cxTable https://raw.githubusercontent.com/zhangwtee/chaoxing-helper/main/font-table.json
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/* global Typr, md5, GM_getValue, GM_setValue, GM_getResourceText, GM_xmlhttpRequest, GM_deleteValue */

(function () {
  'use strict';
  if (window.__cxAllInOne) return;
  window.__cxAllInOne = true;

  // ==================== 配置 ====================
  const CFG = {
    TICK: 4000,
    FORCE_RATE: 1.0,
    SERVER_GRACE: 45000,
    MAX_TASK_MIN: 90,
    CHAPTER_GAP: [25000, 55000],
    WORK_WAIT_MIN: 60,
    HOUR_START: 8,
    HOUR_END: 23,
    AUTO_ANSWER: true,   // 检测到测验会自动答题（只填不提交）
    AUTO_SUBMIT: false,  // 「答完自动提交」勾选框：勾上才在答完后自动交卷
    ANSWER_DELAY: 8000,  // 每题之间的读题停顿（毫秒），避免「作答过快」
    BTN_SCALE: 1.0,      // 面板按钮大小缩放（滑块调节，0.75~1.5）
  };

  // 敏感配置走 Tampermonkey 隔离存储，同时双写 localStorage 备份
  // （Tampermonkey 覆盖安装会清空 GM 存储，双写能让配置活下来）
  function gmGet(key, def) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, null);
        if (v != null) {
          let o = v;
          if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { o = null; } }
          if (o && typeof o === 'object' && Object.keys(o).length) return o;
        }
      }
    } catch (e) {}
    try {
      const s = localStorage.getItem('cx-bak-' + key);
      if (s) {
        const o = JSON.parse(s);
        if (o && typeof o === 'object' && Object.keys(o).length) return o;
      }
    } catch (e) {}
    return def;
  }

  function gmSet(key, val) {
    const s = JSON.stringify(val);
    let ok = false;
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, s); ok = true; }
    } catch (e) {}
    try { localStorage.setItem('cx-bak-' + key, s); ok = true; } catch (e) {}
    return ok;
  }

  // ---- 运行意图持久化 ----
  // 切章节/页面整页重载会清空内存状态，这里记住「用户是否想继续刷」：
  // 点开始置位、手动停止或本轮跑完清除；重载后 boot 据此自动续跑。
  function setRunIntent(on) {
    gmSet('cx-run-intent', { on: !!on, t: Date.now() });
  }
  function getRunIntent() {
    const v = gmGet('cx-run-intent', {});
    if (!v || v.on !== true) return false;
    // 太久之前的意图（隔天/隔周打开页面）不再自动续跑
    if (!v.t || Date.now() - v.t > 12 * 3600000) return false;
    return true;
  }
  // ---- 敏感字段混淆（XOR + base64），防止存储文件和界面里出现明文 ----
  const OBF_SALT = 'cx-allinone-v2-7f3a91e4';

  function obf(plain) {
    if (!plain) return '';
    try {
      const s = OBF_SALT;
      let out = '';
      for (let i = 0; i < plain.length; i++) {
        out += String.fromCharCode(plain.charCodeAt(i) ^ s.charCodeAt(i % s.length));
      }
      return 'OBF1:' + btoa(unescape(encodeURIComponent(out)));
    } catch (e) { return plain; }
  }

  function deobf(stored) {
    if (!stored) return '';
    const v = String(stored);
    if (!v.startsWith('OBF1:')) return v; // 兼容旧的明文
    try {
      const raw = decodeURIComponent(escape(atob(v.slice(5))));
      const s = OBF_SALT;
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ s.charCodeAt(i % s.length));
      }
      return out;
    } catch (e) { return ''; }
  }

  const $ = (s, r = document) => (r ? r.querySelector(s) : null);
  const $$ = (s, r = document) => (r ? [...r.querySelectorAll(s)] : []);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = ([a, b]) => a + Math.random() * (b - a);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const LOGS = [];
  const STATE = { running: false, phase: '待启动', done: 0, total: 0, err: false, userStopped: false, reviveCount: 0, workDoc: null, questions: [], aiBusy: false, autoAnswered: new Set() };

  let panel = null;

  function log(...a) {
    const s = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    LOGS.push(`[${new Date().toLocaleTimeString().slice(0, 5)}] ${s}`);
    if (LOGS.length > 400) LOGS.shift();
    try { console.log('[cx]', ...a); } catch (e) {}
    renderLog();
  }

  function renderLog() {
    const el = $('#cx-log');
    if (el) { el.textContent = LOGS.slice(-40).join('\n'); el.scrollTop = el.scrollHeight; }
    const b = $('#cx-badge-log');
    if (b) b.textContent = LOGS.length ? String(LOGS.length) : '';
  }

  function inWorkWindow() {
    const h = new Date().getHours();
    return h >= CFG.HOUR_START && h < CFG.HOUR_END;
  }

  async function waitFor(fn, timeout = 20000, step = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const r = fn(); if (r) return r; } catch (e) {}
      await sleep(step);
    }
    return null;
  }

  // ==================== 页面句柄 ====================
  const H = {
    course: () => ($('#curCourseId') || {}).value,
    clazz: () => ($('#curClazzId') || {}).value,
    cpi: () => ($('#curCpi') || {}).value,
    chapter: () => ($('#curChapterId') || {}).value,
  };

  function cardsDoc() {
    const f = document.getElementById('iframe');
    try { return f && f.contentDocument && f.contentDocument.body ? f.contentDocument : null; }
    catch (e) { return null; }
  }

  // 在整棵 frame 树里找带题目的文档
  function findWorkDoc() {
    const seen = new Set();
    function search(win, depth) {
      if (depth > 6 || !win || seen.has(win)) return null;
      seen.add(win);
      let doc;
      try { doc = win.document; } catch (e) { return null; }
      if (!doc || !doc.body) return null;
      try {
        if (doc.querySelectorAll('.TiMu.newTiMu').length) return doc;
      } catch (e) {}
      let frames = [];
      try { frames = [...doc.querySelectorAll('iframe')]; } catch (e) {}
      for (const f of frames) {
        try {
          if (f.contentDocument && f.contentDocument.body) {
            const r = search(f.contentWindow, depth + 1);
            if (r) return r;
          }
        } catch (e) {}
      }
      return null;
    }
    return search(window, 0);
  }

  // ==================== 字体解密 ====================
  function buildCmap(font) {
    const out = {};
    const c = font && font.cmap;
    if (!c) return out;
    if (!c.tables) {
      for (const k in c) {
        const v = c[k];
        if (typeof v === 'number') { const cp = Number(k); if (!isNaN(cp)) out[cp] = v; }
      }
      return out;
    }
    for (const t of (c.tables || [])) {
      if (!t) continue;
      if (t.format === 4) {
        const seg = (t.startCount || []).length;
        const gArr = t.glyphIdArray || t.glyphId || [];
        for (let i = 0; i < seg; i++) {
          const s = t.startCount[i], e = t.endCount[i];
          const d = (t.idDelta || [])[i] || 0;
          const ro = (t.idRangeOffset || [])[i] || 0;
          if (s === undefined || e === undefined) continue;
          for (let cp = s; cp <= e && cp !== 0xFFFF; cp++) {
            let gid = 0;
            if (!ro) gid = (cp + d) & 0xFFFF;
            else {
              const idx = ro / 2 + (cp - s) - (seg - i);
              gid = gArr[idx] || 0;
              if (gid) gid = (gid + d) & 0xFFFF;
            }
            if (gid) out[cp] = gid;
          }
        }
      } else if (t.format === 12 && t.groups) {
        for (const g of t.groups) {
          for (let cp = g.startCharCode; cp <= g.endCharCode; cp++) out[cp] = g.startGlyphID + (cp - g.startCharCode);
        }
      }
    }
    return out;
  }

  function decryptIn(doc) {
    const res = { ok: false, replaced: 0, mapped: 0, note: '' };
    let style = null;
    try {
      style = doc.getElementById('cxSecretStyle') ||
        $$('style', doc).find((s) => /font-cxsecret/.test(s.textContent || ''));
    } catch (e) {}
    if (!style) { res.ok = true; res.note = '无加密字体'; return res; }

    try {
      if (typeof Typr === 'undefined' || typeof md5 === 'undefined') { res.note = 'Typr/md5 未加载'; return res; }
      const m = style.textContent.match(/base64,([A-Za-z0-9+/=\s]+?)[)"']/);
      if (!m) { res.note = '提不到 base64'; return res; }

      const bin = atob(m[1].replace(/\s/g, ''));
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

      const font = Typr.parse(buf.buffer)[0];
      const cmap = buildCmap(font);
      const raw = typeof GM_getResourceText === 'function' ? GM_getResourceText('cxTable') : null;
      if (!raw) { res.note = '解密表为空'; return res; }
      const table = JSON.parse(raw);

      const map = {};
      for (const cp in cmap) {
        let p;
        try { p = Typr.U.glyphToPath(font, cmap[cp]); } catch (e) { continue; }
        const h = md5(JSON.stringify(p)).slice(24, 32);
        if (table[h]) map[cp] = String.fromCodePoint(table[h]);
      }
      res.mapped = Object.keys(map).length;

      let n = 0;
      $$('.font-cxsecret, [class*="font-cxsecret"]', doc).forEach((el) => {
        const w = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
        let t;
        while ((t = w.nextNode())) {
          let o = '', ch = false;
          for (const c of t.nodeValue) {
            const cp = c.codePointAt(0);
            if (map[cp]) { o += map[cp]; ch = true; n++; } else o += c;
          }
          if (ch) t.nodeValue = o;
        }
        el.style.setProperty('font-family', 'inherit', 'important');
        el.classList.remove('font-cxsecret');
      });

      res.ok = true; res.replaced = n;
      return res;
    } catch (e) {
      res.note = '异常: ' + e.message;
      return res;
    }
  }

  // ==================== 做题：解析 / 填答 ====================
  function findEditorBox(ta) {
    let p = ta.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      if (p.querySelector && p.querySelector('iframe')) return p;
      p = p.parentElement;
    }
    return null;
  }

  function readEditor(ed) {
    // iframe 可能已经重建，每次重新定位
    let iframe = ed.iframe;
    let valid = false;
    try { valid = !!(iframe && iframe.contentDocument && iframe.contentDocument.body); } catch (e) { valid = false; }
    if (!valid) {
      try {
        const box = findEditorBox(ed.ta);
        iframe = box ? box.querySelector('iframe') : null;
        ed.iframe = iframe;
      } catch (e) {}
    }

    try {
      const w = ed.ta.ownerDocument.defaultView;
      if (w && w.UE && w.UE.getEditor) {
        const inst = w.UE.getEditor(ed.ta.id);
        if (inst && typeof inst.getContent === 'function') {
          const txt = inst.getContent().replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
          if (txt) return txt;
        }
      }
    } catch (e) {}

    try {
      const b = iframe && iframe.contentDocument && iframe.contentDocument.body;
      if (b) {
        const t = (b.innerText || b.textContent || '').trim();
        if (t) return t;
      }
    } catch (e) {}

    return (ed.ta.value || '').trim();
  }

  function setEditor(ed, value) {
    try {
      const w = ed.ta.ownerDocument.defaultView;
      if (w && w.UE && w.UE.getEditor) {
        const inst = w.UE.getEditor(ed.ta.id);
        if (inst && typeof inst.setContent === 'function') {
          inst.setContent(value);
          ed.ta.value = value;
          return 'UE';
        }
      }
    } catch (e) {}
    try {
      const b = ed.iframe && ed.iframe.contentDocument && ed.iframe.contentDocument.body;
      if (b) {
        b.innerText = value;
        b.dispatchEvent(new Event('input', { bubbles: true }));
        ed.ta.value = value;
        return 'iframe';
      }
    } catch (e) {}
    ed.ta.value = value;
    return 'textarea';
  }

  function parseWork(doc) {
    return $$('.TiMu.newTiMu', doc).map((el, i) => {
      const inp = el.querySelector('input[name^="answer"]');
      const lis = $$('li', el);
      const opts = lis.map((li) => {
        const al = li.getAttribute('aria-label') || '';
        const mk = al.match(/^([A-Z])/);
        const mt = li.textContent.trim().match(/^([A-Z])[\s.．、]/);
        return { key: (mk && mk[1]) || (mt && mt[1]) || '', text: li.textContent.trim(), li };
      }).filter((o) => o.key);

      let kind = 'unknown';
      if (lis.length) kind = lis[0].getAttribute('role') === 'checkbox' ? 'multi' : 'single';
      const tas = $$('textarea', el);
      if (tas.length) kind = 'blank';

      const editors = tas.map((ta) => {
        const box = findEditorBox(ta);
        return { ta, iframe: box ? box.querySelector('iframe') : null };
      });

      const stemEl = el.querySelector('.qtContent, [class*="TItle"]');
      return {
        idx: i, el, inp, kind, opts, editors, tas,
        qid: inp ? inp.name.replace('answer', '') : '',
        stem: stemEl ? stemEl.textContent.trim().replace(/\s+/g, ' ') : '',
      };
    });
  }

  function curAnswer(q, doc) {
    if (q.kind === 'blank') return q.editors.map((ed) => readEditor(ed)).join('|');
    return q.inp ? (q.inp.value || '') : '';
  }

  function clickOpt(q, key) {
    const o = q.opts.find((x) => x.key === key);
    if (!o) return false;
    const w = o.li.ownerDocument.defaultView;
    const mm = (o.li.getAttribute('onclick') || '').match(/([A-Za-z_$][\w$]*)\s*\(/);
    const fn = mm && w[mm[1]];
    if (typeof fn !== 'function') return false;
    try { fn(o.li); return true; } catch (e) { return false; }
  }

  function fillOne(q, raw) {
    const clean = String(raw || '').replace(/[\s,，、;；]/g, '').toUpperCase();

    if (q.kind === 'blank') {
      const parts = String(raw || '').split(/[|｜]/).map((s) => s.trim());
      const how = [];
      q.editors.forEach((ed, i) => how.push(setEditor(ed, parts[i] || '')));
      const now = q.editors.map((ed) => readEditor(ed)).join('|');
      const want = q.editors.map((ed, i) => parts[i] || '').join('|');
      return { ok: now.replace(/\s/g, '') === want.replace(/\s/g, ''), now, how: how.join(',') };
    }

    if (!clean) return { ok: false, now: curAnswer(q) };
    const before = curAnswer(q).split('');
    for (const ch of before) if (!clean.includes(ch)) clickOpt(q, ch);
    const now = curAnswer(q).split('');
    for (const ch of clean) if (!now.includes(ch)) clickOpt(q, ch);
    const after = curAnswer(q);
    return { ok: after.split('').sort().join('') === clean.split('').sort().join(''), now: after };
  }

  // ==================== 题库 ====================
  // 题库答案（非敏感，量可能大，用 localStorage）
  const loadBank = () => { try { return JSON.parse(localStorage.getItem('cx-work-bank') || '{}'); } catch (e) { return {}; } };
  const saveBank = (b) => { try { localStorage.setItem('cx-work-bank', JSON.stringify(b)); } catch (e) {} };
  const fp = (q) => md5(q.stem + '||' + q.opts.map((o) => o.key + '.' + o.text).join('|')).slice(0, 16);

  // ==================== AI ====================
  function loadAI() {
    const v = gmGet('cx-ai-config', null);
    let o = {};
    if (v && typeof v === 'object') o = v;
    else { try { o = JSON.parse(v || '{}'); } catch (e) { o = {}; } }
    return { url: o.url || '', key: deobf(o.key || ''), model: o.model || '' };
  }
  function saveAI(c) {
    gmSet('cx-ai-config', { url: c.url || '', key: obf(c.key || ''), model: c.model || '' });
  }

  function gmPost(url, headers, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest 不可用'));
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: 60000,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }

  function buildPrompt(q) {
    const typeName = { multi: '多选题', single: '单选题', blank: '填空题' }[q.kind] || '题目';
    let s = `题型：${typeName}\n题目：${q.stem}\n`;
    if (q.opts.length) {
      s += '选项：\n' + q.opts.map((o) => `${o.key}. ${o.text}`).join('\n');
      s += '\n\n只输出正确答案的选项字母（多选直接连写，如 ABD），不要任何解释、标点或空格。';
    } else {
      s += `\n这道题有 ${q.editors.length} 个空。只输出答案，多个空用 | 分隔，不要解释。`;
    }
    return s;
  }

  // AI 配置必须三项齐全才算可用，不做隐式兜底
  function aiReady() {
    const c = loadAI();
    return !!(c.url && c.key && c.model);
  }

  async function askAI(q) {
    const ai = loadAI();
    if (!ai.url) throw new Error('未填 API 地址');
    if (!ai.key) throw new Error('未填 API Key');
    if (!ai.model) throw new Error('未填模型名');

    const body = JSON.stringify({
      model: ai.model,
      messages: [
        { role: 'system', content: '你是答题助手，只输出答案本身，绝不输出解释。' },
        { role: 'user', content: buildPrompt(q) },
      ],
      temperature: 0,
    });

    const r = await gmPost(ai.url, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + ai.key,
    }, body);

    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' ' + String(r.responseText || '').slice(0, 120));

    let j;
    try { j = JSON.parse(r.responseText); } catch (e) { throw new Error('返回不是 JSON'); }

    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || j.content || '';
    if (!txt) throw new Error('返回为空');

    // 清洗
    let ans = String(txt).trim();
    ans = ans.replace(/^```[\s\S]*?\n|```$/g, '').trim();
    if (q.opts.length) {
      const letters = ans.toUpperCase().match(/[A-Z]/g);
      if (!letters) throw new Error('模型没给字母: ' + ans.slice(0, 40));
      return [...new Set(letters)].sort().join('');
    }
    return ans.replace(/^答案[:：]?\s*/, '').replace(/\n+/g, '|').trim();
  }

  // 智能答题按钮的运行态反馈
  function setAiBusyUI(busy, done, total) {
    const b = $('#cx-ai');
    if (b) {
      b.textContent = busy ? (total ? `答题中 ${done}/${total}` : '答题中…') : '智能答题';
      b.style.opacity = busy ? '0.65' : '';
      b.style.cursor = busy ? 'not-allowed' : '';
    }
  }

  async function aiAnswerAll() {
    if (STATE.aiBusy) { log('正在答题中，请稍候…'); return; }
    const doc = STATE.workDoc;
    if (!doc) { log('当前没有测验'); return; }

    const tiku = loadTiku();
    if (!tiku.url && !aiReady()) {
      log('还没配置题库或 AI，点「设置」填一下');
      openSettings();
      return;
    }

    STATE.aiBusy = true;
    const qs = STATE.questions;
    let ok = 0;
    const filledKeys = new Set();   // 真正成功填入的题目，供调用方精确标记
    setAiBusyUI(true, 0, qs.length);
    try {
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi];
        const key = fp(q);
        STATE.phase = `答题中 ${qi + 1}/${qs.length}`;
        setAiBusyUI(true, qi + 1, qs.length);
        paintState();
        const bank = loadBank();
        let ans = bank[key];
        let from = '';

        // ① 本地库
        if (ans) {
          from = '本地库';
          log(`第${q.idx + 1}题 本地库: ${ans}`);
        }

        // ② tikuAdapter
        if (!ans && tiku.url) {
          log(`第${q.idx + 1}题 查题库…`);
          try {
            ans = await askTiku(q);
            if (ans) { from = '题库'; log(`第${q.idx + 1}题 题库: ${ans}`); }
            else log(`第${q.idx + 1}题 题库无结果`);
          } catch (e) {
            log(`第${q.idx + 1}题 题库失败: ${e.message}`);
          }
        }

        // ③ AI
        if (!ans && aiReady()) {
          log(`第${q.idx + 1}题 问 AI…`);
          try {
            ans = await askAI(q);
            from = 'AI';
            log(`第${q.idx + 1}题 AI: ${ans}`);
          } catch (e) {
            log(`第${q.idx + 1}题 AI 失败: ${e.message}`);
            continue;
          }
        }

        if (!ans) { log(`第${q.idx + 1}题 无答案，跳过`); continue; }
        if (from !== '本地库') { bank[key] = ans; saveBank(bank); }

        const r = fillOne(q, ans);
        if (r.ok) {
          ok++;
          filledKeys.add(fp(q));
          const inp = $(`#cx-panel .ansinp[data-idx="${q.idx}"]`);
          if (inp) inp.value = ans;
        } else {
          log(`第${q.idx + 1}题 填入失败，实际"${r.now}"`);
        }

        // 模拟读题停顿，避免「作答过快」被判定异常
        const base = Math.max(0, CFG.ANSWER_DELAY || 0);
        if (base > 0 && q !== qs[qs.length - 1]) {
          const wait = base + Math.random() * 6000;
          STATE.phase = `答题中… 停顿 ${Math.round(wait / 1000)} 秒`;
          paintState();
          await sleep(wait);
        }
      }
      log(`答题完成：${ok}/${qs.length}`);
      if (ok > 0) log('★ 已填好，请核对后自己点页面上的「提交」');
      return filledKeys;
    } finally {
      STATE.aiBusy = false;
      setAiBusyUI(false);
      STATE.phase = STATE.phase.startsWith('答题中') ? '答题完成' : STATE.phase;
      paintState();
      refreshWork();
    }
  }

  // 检测到测验且页面全空白 → 自动跑一遍三层流程
  let autoRunning = false;
  let lastAutoAt = 0;   // 自动答题冷却：失败后不要每 4 秒重试刷屏
  async function maybeAutoAnswer() {
    if (!CFG.AUTO_ANSWER || autoRunning || STATE.aiBusy) return;
    if (Date.now() - lastAutoAt < 90000) return;   // 90 秒内不重复自动尝试（手动点按钮不受限）
    const qs = STATE.questions;
    if (!qs.length) return;

    // 本次会话内已经自动答过的题，不再重复
    const todo = qs.filter((q) => !STATE.autoAnswered.has(fp(q)));
    if (!todo.length) return;

    // 已有内容的题各记各的，只把它们标记掉；其余空题照常自动答，不再一票否决全部
    qs.forEach((q) => {
      const v = curAnswer(q);
      if (v && String(v).trim()) STATE.autoAnswered.add(fp(q));
    });

    const configured = loadTiku().url || aiReady();
    if (!configured) return; // 没配任何数据源就不折腾

    autoRunning = true;
    lastAutoAt = Date.now();
    log('检测到未作答的测验，自动开始…');
    try {
      const filled = await aiAnswerAll();
      // 只标记真正填入成功的题；失败的留到下次重试（有防抖，不会刷屏）
      if (filled) filled.forEach((k) => STATE.autoAnswered.add(k));
      // 自动提交（默认关）：题目全答完才提交，留空不贸然交卷
      if (CFG.AUTO_SUBMIT && filled && filled.size === qs.length && unansweredCount() === 0) {
        log('自动答题完成，自动提交…');
        await submitWork(true);
      }
    } catch (e) {
      log('自动答题异常：' + e.message);
    } finally {
      autoRunning = false;
    }
  }

  // ==================== 测验提交 ====================
  // 学习通提交是两步：btnBlueSubmit() 弹出确认框 → 点确认框里的 #popok。
  // #popok 由 jQuery 绑定，普通 el.click() 有时不触发，派发完整鼠标事件序列更稳。
  let submitting = false;

  function fireClick(el, doc) {
    const w = doc.defaultView || window;
    let fired = false;
    try {
      ['mousedown', 'mouseup', 'click'].forEach((t) => {
        el.dispatchEvent(new w.MouseEvent(t, { bubbles: true, cancelable: true, view: w }));
      });
      fired = true;
    } catch (e) {
      try { el.click(); fired = true; } catch (e2) {}
    }
    return fired;
  }

  // 还有未答的题吗（空字符串视为未答）
  function unansweredCount() {
    if (!STATE.questions || !STATE.questions.length) return 0;
    return STATE.questions.filter((q) => {
      const v = curAnswer(q);
      return !v || !v.split('|').some((s) => String(s).trim());
    }).length;
  }

  // 在文档里找提交入口按钮
  function findSubmitButton(doc) {
    const sels = [
      'input[type="submit"][value*="提交"]',
      'input[value*="提交"]', 'input[value*="交卷"]',
      'button[onclick*="btnBlueSubmit"]', 'input[onclick*="btnBlueSubmit"]',
      '.btnBlueSubmit', '#btnBlueSubmit', 'button[onclick*="submit"]',
      '.submit-btn', '.btn-submit', '#submit', '.submit',
    ];
    for (const s of sels) {
      let el = null;
      try { el = doc.querySelector(s); } catch (e) {}
      if (el && !el.disabled && !el.classList.contains('disabled')) return el;
    }
    // 文本兜底
    const all = doc.querySelectorAll('input,button,a,span');
    for (const el of all) {
      const t = (el.value || el.textContent || '').trim();
      if (/^(提交|提交答案|交卷|确认提交)$/.test(t) && el.offsetParent !== null) return el;
    }
    return null;
  }

  // 找到确认弹窗里的确定按钮（常见 #popok）
  function findConfirmButton(doc) {
    let el = null;
    try { el = doc.querySelector('#popok'); } catch (e) {}
    if (el && el.offsetParent !== null) return el;
    const all = doc.querySelectorAll('a,button,input');
    for (const x of all) {
      const t = (x.value || x.textContent || '').trim();
      if (/^(确定|确认|提交)$/.test(t) && x.offsetParent !== null) return x;
    }
    return null;
  }

  // 提交流程；返回 {ok, reason}。skipCheck=true 时跳过未答校验（用于「仍要提交」）
  async function submitWork(skipCheck) {
    if (submitting) { log('正在提交中…'); return { ok: false, reason: 'busy' }; }
    const doc = STATE.workDoc || findWorkDoc();
    if (!doc) { log('当前没有测验，无法提交'); return { ok: false, reason: 'no-doc' }; }
    const w = doc.defaultView;
    if (!w) { log('测验页面环境异常'); return { ok: false, reason: 'no-window' }; }

    // 提交前校验未答题，避免半答就交（提交通常不可撤回）
    const un = unansweredCount();
    if (un > 0 && !skipCheck) {
      log(`还有 ${un} 题未作答，已停止提交（补全后再点，或点「强制提交」）`);
      return { ok: false, reason: 'unanswered', count: un };
    }

    submitting = true;
    try {
      // 第一步：调用 btnBlueSubmit 或点击提交按钮，弹出确认框
      let step1 = false;
      if (typeof w.btnBlueSubmit === 'function') {
        try { w.btnBlueSubmit(); step1 = true; log('已触发提交，等待确认框…'); }
        catch (e) { log('btnBlueSubmit 失败：' + e.message); }
      }
      if (!step1) {
        const btn = findSubmitButton(doc);
        if (btn) {
          fireClick(btn, doc);
          step1 = true;
          log('已点击页面提交按钮，等待确认框…');
        }
      }
      if (!step1) {
        log('没找到提交入口，请手动到页面点「提交」');
        return { ok: false, reason: 'no-button' };
      }

      // 第二步：等确认框出现后点确定。轮询几次，兼容弹出延迟
      let confirmed = false;
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        const okBtn = findConfirmButton(doc);
        if (okBtn) {
          fireClick(okBtn, doc);
          confirmed = true;
          break;
        }
      }
      if (confirmed) log('已确认提交');
      else log('未捕获确认框，请到页面手动确认（提交可能已弹出等待）');

      await sleep(1500);
      log('提交动作已发出，请核对页面成绩/结果');
      return { ok: true, confirmed };
    } finally {
      submitting = false;
    }
  }

  // ==================== 题库（tikuAdapter） ====================
  function loadTiku() {
    const v = gmGet('cx-tiku-config', null);
    let o = {};
    if (v && typeof v === 'object') o = v;
    else { try { o = JSON.parse(v || '{}'); } catch (e) { o = {}; } }
    return { url: deobf(o.url || '') };
  }
  function saveTiku(c) {
    gmSet('cx-tiku-config', { url: obf(c.url || '') });
  }

  const TIKU_TYPE = { single: 0, multi: 1, blank: 2, judge: 3 };

  const stripKey = (text) => String(text || '').replace(/^[A-Za-z][\s.．、:：]*/, '').trim();

  async function askTiku(q) {
    const cfg = loadTiku();
    if (!cfg.url) return null;

    const body = JSON.stringify({
      question: q.stem,
      options: q.opts.map((o) => stripKey(o.text)),
      type: TIKU_TYPE[q.kind] != null ? TIKU_TYPE[q.kind] : 0,
    });

    const r = await gmPost(cfg.url, { 'Content-Type': 'application/json' }, body);
    if (!r || r.status < 200 || r.status >= 300) throw new Error('HTTP ' + (r ? r.status : '?'));

    let j;
    try { j = JSON.parse(r.responseText); } catch (e) { throw new Error('返回非 JSON'); }
    const a = j && j.answer;
    if (!a) return null;

    if (q.kind === 'blank') {
      const t = a.answerText || (a.bestAnswer && a.bestAnswer.join('|')) || '';
      const s = String(t).replace(/#/g, '|').trim();
      return s || null;
    }
    const k = a.answerKeyText || (a.answerKey && a.answerKey.join('')) || '';
    const letters = String(k).toUpperCase().replace(/[^A-Z]/g, '');
    return letters || null;
  }

  // ==================== 文档 / 阅读任务点：模拟阅读 ====================
  let keepAliveTimer = null;

  // 阅读模式专用：跟踪单个文档的阅读进度，慢速单向推进，不来回扫
  const readSession = { active: false, frame: null, lastPage: 0, lastAction: 0, atBottomSince: 0, bottomPauseMs: 0 };

  // 找出所有文档类任务点 iframe
  function findDocFrames() {
    const out = [];
    const seen = new Set();
    (function walk(win, depth) {
      if (depth > 6 || !win || seen.has(win)) return;
      seen.add(win);
      let doc;
      try { doc = win.document; } catch (e) { return; }
      if (!doc) return;
      let frames = [];
      try { frames = [...doc.querySelectorAll('iframe')]; } catch (e) {}
      frames.forEach((f) => {
        const src = f.getAttribute('src') || '';
        if (/ananas\/modules\/(document|read|insertdoc|pdf|pptx|ppt)/i.test(src)) {
          try {
            if (f.contentDocument && f.contentDocument.body) {
              out.push({ win: f.contentWindow, doc: f.contentDocument, src: src.slice(0, 80) });
            }
          } catch (e) {}
        }
        try { if (f.contentDocument) walk(f.contentWindow, depth + 1); } catch (e) {}
      });
    })(window, 0);
    return out;
  }

  function startKeepReading() {
    if (keepAliveTimer) return;
    const targets = findDocFrames();
    if (!targets.length) return;

    log(`检测到 ${targets.length} 个文档任务点，开始模拟阅读`);
    let dir = 1;

    const tick = () => {
      targets.forEach((t) => {
        try {
          const d = t.doc, w = t.win;
          const sc = d.scrollingElement || d.documentElement || d.body;
          if (!sc) return;
          const max = Math.max(0, (sc.scrollHeight || 0) - (w.innerHeight || 0));

          // 1. 滚动（主要活动信号）
          if (max > 80) {
            const step = 70 + Math.random() * 220;
            let top = (sc.scrollTop || 0) + step * dir;
            if (top >= max - 30) dir = -1;
            if (top <= 0) { dir = 1; top = 0; }
            try { w.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: 'smooth' }); }
            catch (e) { sc.scrollTop = top; }
          }

          // 2. 偶发翻页（PPT/PDF 型）
          if (Math.random() < 0.1) {
            const nx = d.querySelector('.nextPage, .page-next, #nextPage, [class*="next-page"], [class*="nextPage"]');
            if (nx && !/disabled/.test(nx.className || '')) {
              try { nx.click(); } catch (e) {}
            }
          }

          // 3. 鼠标移动（补充活动信号）
          if (Math.random() < 0.55) {
            const W = w.innerWidth || 800, H = w.innerHeight || 600;
            const x = 60 + Math.random() * Math.max(20, W - 120);
            const y = 60 + Math.random() * Math.max(20, H - 120);
            try {
              d.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
            } catch (e) {}
          }

          // 4. 极偶发的文本选择（模拟划重点）
          if (Math.random() < 0.03) {
            try {
              const sel = w.getSelection();
              const p = d.querySelector('p, div');
              if (sel && p && p.firstChild && p.firstChild.nodeType === 3) {
                sel.removeAllRanges();
                const r = d.createRange();
                r.setStart(p.firstChild, 0);
                r.setEnd(p.firstChild, Math.min(20, p.firstChild.length));
                sel.addRange(r);
              }
            } catch (e) {}
          }
        } catch (e) {}
      });
    };

    tick();
    keepAliveTimer = setInterval(tick, 4500 + Math.random() * 4500);
  }

  function stopKeepReading() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      log('停止模拟阅读');
    }
    readSession.active = false;
    readSession.frame = null;
  }

  // 阅读模式：慢速单向阅读，只往下翻，不来回扫，动作间隔拉长
  // 目的是让行为落在「正常阅读」区间，而不是被判成脚本高速滑动
  function startReadSession() {
    if (keepAliveTimer) return;
    const targets = findDocFrames();
    if (!targets.length) { log('阅读模式：没找到文档 iframe，先点开要读的内容页'); return; }

    readSession.active = true;
    readSession.frame = targets[0];
    readSession.lastPage = 0;
    readSession.lastAction = 0;
    readSession.atBottomSince = 0;
    readSession.bottomPauseMs = 0;
    log(`阅读模式：开始慢速阅读 ${targets.length} 个文档页`);

    const tick = () => {
      if (!READ.enabled || !STATE.running) return;
      const t = readSession.frame || targets[0];
      try {
        const d = t.doc, w = t.win;
        const sc = d.scrollingElement || d.documentElement || d.body;
        if (!sc) return;
        const max = Math.max(0, (sc.scrollHeight || 0) - (w.innerHeight || 0));
        const now = Date.now();

        // 慢速单向滚动：每次只走一小段，到底后停留一会儿再重头
        if (max > 40) {
          const step = 40 + Math.random() * 90;
          let top = (sc.scrollTop || 0) + step;
          if (top >= max) {
            top = max;
            // 首次到达页底：先记下时间并停下，下一轮才开始计时（避免 lastAction=0 导致立刻回顶）
            if (!readSession.atBottomSince) {
              readSession.atBottomSince = now;
              readSession.bottomPauseMs = 20000 + Math.random() * 20000;
              try { w.scrollTo({ top, behavior: 'instant' }); } catch (e) { sc.scrollTop = top; }
            } else if (now - readSession.atBottomSince < readSession.bottomPauseMs) {
              // 仍在读页底的停顿期，保持位置不动
              try { w.scrollTo({ top, behavior: 'instant' }); } catch (e) { sc.scrollTop = top; }
              return;
            } else {
              readSession.atBottomSince = 0;
              readSession.bottomPauseMs = 0;
              top = 0;
              log('阅读模式：读到页底，回到开头继续');
              try { w.scrollTo({ top, behavior: 'instant' }); } catch (e) { sc.scrollTop = top; }
            }
          } else {
            readSession.atBottomSince = 0;   // 离开页底后重置，便于下次重新计时
            try { w.scrollTo({ top, behavior: 'instant' }); }
            catch (e) { sc.scrollTop = top; }
          }
        }

        // 翻页：间隔拉长，跟阅读节奏一致
        if (now - readSession.lastPage > 25000 + Math.random() * 20000) {
          const nx = d.querySelector('.nextPage, .page-next, #nextPage, [class*="next-page"], [class*="nextPage"]');
          if (nx && !/disabled/.test(nx.className || '')) {
            try { nx.click(); readSession.lastPage = now; } catch (e) {}
          }
        }

        // 偶发鼠标移动，作为「活跃」信号
        if (Math.random() < 0.4) {
          const W = w.innerWidth || 800, H = w.innerHeight || 600;
          try {
            d.dispatchEvent(new MouseEvent('mousemove', {
              clientX: 60 + Math.random() * Math.max(20, W - 120),
              clientY: 60 + Math.random() * Math.max(20, H - 120),
              bubbles: true, cancelable: true,
            }));
          } catch (e) {}
        }
      } catch (e) {}
    };

    tick();
    keepAliveTimer = setInterval(tick, 3500 + Math.random() * 2500);
  }

  // ==================== 加速模式（伪造心跳） ====================
  const ACCEL = {
    enabled: false,
    concurrency: 3,
    speed: 1.2,
    templates: new Map(),   // jobid -> {base, params, rawUrl, first}
    running: false,
    dumped: false,          // 是否已打印过一次参数差异
    probeDone: false,       // 是否已做过「同进度重发」诊断
  };
  let syncAccelUI = () => {};   // 由 buildPanel 注入，供加速流程在外部更新开关 UI

  // ==================== 阅读模式（阅读时长类任务） ====================
  // 阅读时长按服务端累计，通常次日才更新任务点。这里只做两件事：
  // 1) 保持页面不刷新，避免重建 iframe 打断计时；2) 慢速单向滚动，模拟正常阅读。
  const READ = {
    enabled: false,
    waitHours: 26,   // 跨日等待窗口，覆盖「次日更新」
  };

  // ==================== 三个 UI 数值设置的持久化 ====================
  // 面板重建（切章节整页重载）后这些值会回到默认，所以存进 GM/localStorage
  function savePrefs() {
    gmSet('cx-prefs', {
      answerDelay: CFG.ANSWER_DELAY,
      accelSpeed: ACCEL.speed,
      readHours: READ.waitHours,
      autoSubmit: CFG.AUTO_SUBMIT,
      btnScale: CFG.BTN_SCALE,
    });
  }
  function loadPrefs() {
    const p = gmGet('cx-prefs', {});
    if (!p || typeof p !== 'object') return;
    if (Number.isFinite(p.answerDelay) && p.answerDelay >= 0 && p.answerDelay <= 60000) CFG.ANSWER_DELAY = p.answerDelay;
    if (Number.isFinite(p.accelSpeed) && p.accelSpeed >= 0.5 && p.accelSpeed <= 5) ACCEL.speed = p.accelSpeed;
    if (Number.isFinite(p.readHours) && p.readHours >= 1 && p.readHours <= 72) READ.waitHours = p.readHours;
    if (typeof p.autoSubmit === 'boolean') CFG.AUTO_SUBMIT = p.autoSubmit;
    if (Number.isFinite(p.btnScale) && p.btnScale >= 0.75 && p.btnScale <= 1.5) CFG.BTN_SCALE = p.btnScale;
  }
  loadPrefs();

  const SALT = 'd_yHJ!$pdA~5';

  function accelEnc(clazzId, userid, jobid, objectId, playing, duration, clipTime) {
    return md5(
      '[' + clazzId + '][' + userid + '][' + jobid + '][' + objectId + '][' +
      (Math.floor(playing) * 1000) + '][' + SALT + '][' + (Math.floor(duration) * 1000) + '][' + clipTime + ']'
    );
  }

  // 给视频 iframe 装上报 hook，捕获真实心跳当模板
  function installBeatHook(frame) {
    try {
      const w = frame.contentWindow;
      if (!w || w.__cxBeatHook) return;
      w.__cxBeatHook = true;

      const XO = w.XMLHttpRequest.prototype.open;
      w.XMLHttpRequest.prototype.open = function (m, u) {
        try { if (/multimedia\/log/i.test(String(u))) captureBeat(String(u)); } catch (e) {}
        return XO.apply(this, arguments);
      };

      if (typeof w.fetch === 'function') {
        const OF = w.fetch;
        w.fetch = function (input) {
          try {
            const u = typeof input === 'string' ? input : (input && input.url) || '';
            if (/multimedia\/log/i.test(u)) captureBeat(u);
          } catch (e) {}
          return OF.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  function captureBeat(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      const jobid = u.searchParams.get('jobid');
      if (!jobid) return;
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      // 每次心跳都更新为最新（playingTime 会涨），但保留首跳的 raw 便于对比
      const prev = ACCEL.templates.get(jobid);
      ACCEL.templates.set(jobid, {
        base: u.origin + u.pathname,
        params,
        rawUrl: rawUrl,
        first: prev ? prev.first : { params: Object.assign({}, params), rawUrl: rawUrl },
      });
      if (!prev) log(`采集心跳模板: ${jobid} (duration=${params.duration}, playingTime=${params.playingTime}, isdrag=${params.isdrag})`);
    } catch (e) {}
  }

  function buildFakeUrl(tpl, playing) {
    const p = Object.assign({}, tpl.params);
    const cur = Math.min(Math.floor(playing), Math.floor(parseFloat(p.duration) || 0));
    p.playingTime = String(cur);
    p._t = String(Date.now());
    // 正常播放时 isdrag=3；模板可能抓到 0（暂停/初始化），统一改成 3
    p.isdrag = '3';
    p.enc = accelEnc(p.clazzId, p.userid, p.jobid, p.objectId, cur, p.duration, p.clipTime);
    const qs = Object.keys(p).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
    return tpl.base + '?' + qs;
  }

  // 参数差异对比
  function diffParams(realUrl, fakeUrl) {
    try {
      const a = new URL(realUrl, location.origin);
      const b = new URL(fakeUrl, location.origin);
      const ka = [...a.searchParams.keys()];
      const kb = [...b.searchParams.keys()];
      const lines = [];
      ka.forEach((k) => {
        const va = a.searchParams.get(k);
        const vb = b.searchParams.get(k);
        if (va !== vb) lines.push(`${k}: "${String(va).slice(0, 40)}" → "${String(vb).slice(0, 40)}"`);
      });
      kb.forEach((k) => { if (!ka.includes(k)) lines.push(`+${k}="${String(b.searchParams.get(k)).slice(0, 40)}"`); });
      ka.forEach((k) => { if (!kb.includes(k)) lines.push(`-${k}（伪造包缺少）`); });
      return lines;
    } catch (e) {
      return ['对比失败: ' + e.message];
    }
  }

  async function fakeBeat(jobid, playing) {
    const tpl = ACCEL.templates.get(jobid);
    if (!tpl) return { ok: false, reason: '无模板' };
    const url = buildFakeUrl(tpl, playing);

    // 第一次发送时打印差异
    if (!ACCEL.dumped) {
      ACCEL.dumped = true;
      const real = (tpl.first && tpl.first.rawUrl) || tpl.rawUrl || '';
      const d = diffParams(real, url);
      log('参数差异（真包 → 伪造）: ' + (d.length ? d.join(' | ') : '无'));
    }

    try {
      const r = await fetch(url, { credentials: 'include' });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      if (!j) return { ok: r.ok, reason: 'no-json: ' + txt.slice(0, 60) };
      const passed = j.isPassed !== false;
      return { ok: passed, reason: passed ? '' : (j.msg || JSON.stringify(j).slice(0, 100)), data: j };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // 预热：真实播放一会儿，拿到心跳模板
  async function warmUp(job) {
    if (ACCEL.templates.has(job.jobid)) return true;
    installBeatHook(job.frame);

    const v = videoEl(job.frame);
    if (!v) return false;

    if (!(v.duration > 0)) kickStart(job.frame);
    await waitFor(() => { const x = videoEl(job.frame); return x && x.duration > 0; }, 20000, 500);

    try { v.muted = true; v.playbackRate = 1; await v.play(); } catch (e) {}

    log(`预热 ${job.jobid}：等待首跳心跳…`);
    const got = await waitFor(() => ACCEL.templates.has(job.jobid), 90000, 1000);
    try { v.pause(); } catch (e) {}
    return !!got;
  }

  // 并发伪造
  async function runAccelLoop(jobs) {
    const list = jobs.slice(0, ACCEL.concurrency);
    const state = list.map((j) => ({ job: j, playing: 0, done: false }));

    // 初始化 playing 为服务端已记录（这里简单从 0 起，靠服务端幂等）
    const timer = setInterval(async () => {
      for (const s of state) {
        if (s.done) continue;
        const tpl = ACCEL.templates.get(s.job.jobid);
        if (!tpl) continue;
        const dur = parseFloat(tpl.params.duration) || 0;
        s.playing += 60 * ACCEL.speed;
        if (s.playing >= dur) { s.playing = dur; s.done = true; }
        const r = await fakeBeat(s.job.jobid, s.playing);
        if (r.ok) {
          if (s.done) log(`✅ ${s.job.jobid} 上报完成 ${Math.floor(s.playing)}/${Math.floor(dur)}`);
        } else {
          log(`⚠️ ${s.job.jobid} 被拒: ${r.reason}`);
          s.done = true;
        }
      }
      if (state.every((s) => s.done)) clearInterval(timer);
    }, 60000);
  }

  // ==================== 刷课 ====================
  function chapterEls() {
    let els = $$('#coursetree [id^="cur"]');
    if (!els.length) els = $$('#coursetree .posCatalog_select');
    return els;
  }

  function chapters() {
    return chapterEls().map((el) => {
      const span = el.querySelector('span[title]');
      const bar = el.querySelector('.posCatalog_sbar');
      const lc = el.querySelector('.jobUnfinishCount');
      const id = el.id && el.id.startsWith('cur') ? el.id.slice(3) : el.getAttribute('data-id');
      return {
        id,
        no: bar ? bar.textContent.trim() : '',
        title: span ? span.getAttribute('title') : (el.textContent || '').trim().slice(0, 30),
        left: lc ? parseInt(lc.value || '0', 10) : 0,
      };
    }).filter((c) => c.id);
  }

  function blocked() {
    const vis = (sel) => {
      const el = $(sel);
      if (!el) return false;
      try {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      } catch (e) { return false; }
    };
    if ($('#chapterFaceState')) return '人脸识别';
    if (vis('#chapterVerificationCode') || vis('#chapterVerificationCodeTip')) return '章节验证码';
    if (vis('#mobileBrowerLearnMask')) return '手机浏览器提示';
    if (vis('.jobCountDiv')) {
      const t = $('.jobLimitTip'), v = $('.videoLimitTip');
      const txt = (t && vis('.jobLimitTip') && t.textContent) || (v && vis('.videoLimitTip') && v.textContent) || '';
      return txt ? '每日上限：' + txt.trim() : '每日上限';
    }
    return null;
  }

  async function gotoChapter(chapterId) {
    const courseId = H.course(), clazz = H.clazz(), cpi = H.cpi();
    if (!courseId || !clazz || !cpi) { log('缺参数'); return false; }
    const gap = rnd(CFG.CHAPTER_GAP);
    log(`切章节 ${chapterId}，停 ${(gap / 1000).toFixed(0)}s`);
    await sleep(gap);

    if (typeof window.getTeacherAjax === 'function') {
      try { window.getTeacherAjax(courseId, clazz, chapterId, cpi, '', '', 'false'); }
      catch (e) { log('getTeacherAjax 抛错'); }
    } else {
      const p = new URLSearchParams(location.search);
      p.set('chapterId', chapterId);
      location.search = p.toString();
      return true;
    }
    await sleep(1500);
    if (blocked()) return false;
    return !!(await waitFor(() => H.chapter() === chapterId && cardsDoc(), 20000, 600));
  }

  function videoJobs() {
    const doc = cardsDoc();
    if (!doc) return [];
    return $$('iframe.ans-insertvideo-online', doc).map((fr, i) => {
      let p = fr.parentElement, done = false;
      while (p && p !== doc.body) {
        if (p.classList && p.classList.contains('ans-job-finished')) { done = true; break; }
        p = p.parentElement;
      }
      return { idx: i, frame: fr, jobid: fr.getAttribute('jobid') || '', done };
    });
  }

  function jobCounters() {
    const doc = cardsDoc();
    if (!doc) return { all: 0, done: 0, video: 0 };
    return {
      all: $$('.ans-job-icon', doc).length,
      done: $$('.ans-job-finished', doc).length,
      video: $$('iframe.ans-insertvideo-online', doc).length,
    };
  }

  function videoEl(frame) {
    try {
      const d = frame.contentDocument;
      return d ? (d.querySelector('#video_html5_api') || d.querySelector('video')) : null;
    } catch (e) { return null; }
  }

  function kickStart(frame) {
    try {
      const d = frame.contentDocument;
      if (d) {
        const btn = d.querySelector('.vjs-big-play-button');
        if (btn) { btn.click(); log('点播放按钮'); return 'click'; }
      }
    } catch (e) {}
    try {
      const w = frame.contentWindow;
      if (w && typeof w.videojs === 'function') {
        const p = w.videojs('video');
        if (p && p.play) { p.play(); log('videojs.play'); return 'api'; }
      }
    } catch (e) {}
    return null;
  }

  function playTick(job, ctx) {
    const v = videoEl(job.frame);
    if (!v) return { ok: false, reason: '无 video' };
    if (!(v.duration > 0) || !isFinite(v.duration)) {
      const now = Date.now();
      if (!ctx.lastKick || now - ctx.lastKick > 8000) {
        ctx.lastKick = now;
        ctx.kicks = (ctx.kicks || 0) + 1;
        kickStart(job.frame);
      }
      return { ok: false, waiting: true };
    }
    if (Math.abs(v.playbackRate - CFG.FORCE_RATE) > 0.01) { try { v.playbackRate = CFG.FORCE_RATE; } catch (e) {} }
    if (v.paused && !v.ended) { try { v.muted = true; v.play().catch(() => {}); } catch (e) {} }
    const dur = v.duration, cur = v.currentTime || 0;
    return { ok: true, dur, cur, paused: v.paused, ended: v.ended, localDone: v.ended || cur >= dur - 2 };
  }

  async function reloadCards() {
    const f = document.getElementById('iframe');
    if (!f) return false;
    const src = f.getAttribute('src');
    if (!src) return false;
    log('重载 cards');
    f.setAttribute('src', src);
    return !!(await waitFor(() => {
      const d = cardsDoc();
      return d && d.querySelectorAll('.ans-job-icon').length > 0;
    }, 20000, 600));
  }

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  async function runOneVideo(job) {
    const t0 = Date.now();
    const limit = CFG.MAX_TASK_MIN * 60 * 1000;
    let localDoneAt = 0, failCount = 0, lastLog = 0;
    const ctx = { kicks: 0, lastKick: 0 };

    while (Date.now() - t0 < limit) {
      if (!STATE.running) return { r: 'aborted', why: '手动停止' };
      const b = blocked();
      if (b) return { r: 'blocked', why: b };

      const st = playTick(job, ctx);
      if (!st.ok) {
        if (st.waiting) {
          STATE.phase = `加载视频源 ${job.jobid}（第 ${ctx.kicks} 次）`;
          paintState();
          if (!ctx.waitLog || Date.now() - ctx.waitLog > 15000) { ctx.waitLog = Date.now(); log(`等待视频源…第 ${ctx.kicks} 次`); }
          if (Date.now() - t0 > 90000) return { r: 'retry', why: '视频源 90 秒未加载' };
          await sleep(CFG.TICK);
          continue;
        }
        if (++failCount > 8) return { r: 'stuck', why: st.reason };
        await sleep(CFG.TICK);
        continue;
      }

      STATE.phase = `播放 ${fmt(st.cur)}/${fmt(st.dur)}${st.paused ? ' (暂停)' : ''}`;
      paintState();
      if (Date.now() - lastLog > 60000) {
        lastLog = Date.now();
        log(`进度 ${fmt(st.cur)}/${fmt(st.dur)} (${Math.floor((st.cur / st.dur) * 100)}%)`);
      }

      if (st.localDone) {
        if (!localDoneAt) { localDoneAt = Date.now(); log('本地播完，等记账'); }
        await sleep(CFG.TICK);
        if (Date.now() - localDoneAt > CFG.SERVER_GRACE) {
          // 用「完成数量变化」判定，不依赖 jobid（重载后 iframe 会重建，按 jobid 找不到）
          const beforeDone = jobCounters().done;
          await reloadCards();
          await sleep(3000);
          const c = jobCounters();
          if (c.done > beforeDone) return { r: 'done' };

          // 兜底：按 jobid 找
          const again = videoJobs().find((j) => j.jobid === job.jobid);
          if (again && again.done) return { r: 'done' };

          // 再兜底：整章是否已全完成
          if (c.all > 0 && c.done >= c.all) return { r: 'done' };

          return { r: 'stuck', why: `播完但服务端未标记（完成数 ${beforeDone}→${c.done}）` };
        }
        continue;
      }
      await sleep(CFG.TICK);
    }
    return { r: 'timeout', why: '超时' };
  }

  // 加速模式：预热 + 伪造上报
  async function runOneAccel(job) {
    if (!ACCEL.templates.has(job.jobid)) {
      const ok = await warmUp(job);
      if (!ok) return { r: 'stuck', why: '预热 90 秒仍拿不到心跳模板' };
    }

    const tpl = ACCEL.templates.get(job.jobid);
    const dur = parseFloat(tpl.params.duration) || 0;
    if (!dur) return { r: 'stuck', why: '模板缺 duration' };

    // 关键：从首次心跳记录的 playingTime 接着涨，不能从 0 重来（否则进度倒退）
    let playing = parseInt(tpl.params.playingTime, 10) || 0;
    if (!(playing > 0)) playing = 0;
    log(`加速起点 ${fmt(playing)}/${fmt(dur)}（沿用已有进度）`);

    // 第一跳用 1.0 倍速起步，之后再用设定倍速（服务端对首跳更敏感）
    let step = 60 * ACCEL.speed;

    // 服务端按「间隔 / 增量」比值判断。刚拿到首跳就立刻发下一条 = 比值爆炸，必被拒。
    // 所以第一次上报前先等满一个周期。
    log('等 60 秒凑满一个上报周期…');
    await sleep(60000);

    // ---- 决定性诊断：发一次 playingTime 不变的心跳 ----
    // 通过 → 说明服务端只校验参数，限制在「增量」；调用方可以调小 speed
    // 被拒 → 说明服务端对同一进度防重放，伪造路线不可行
    if (!ACCEL.probeDone) {
      ACCEL.probeDone = true;
      log(`诊断：发一次 playingTime 不变（=${Math.floor(playing)}）的心跳…`);
      const pr = await fakeBeat(job.jobid, playing);
      if (pr.ok) {
        log('✓ 通过 → 服务端接受重复进度，问题在「单次增量太大」，可以把倍速调小试试');
      } else {
        log('✗ 被拒 → 服务端对重复进度防重放：' + pr.reason);
        log('   → 伪造心跳这条路走不通，已自动关闭加速，改用真实播放');
        ACCEL.enabled = false;
        syncAccelUI();   // 诊断已判定不可用，自动关掉开关，避免每章重复白等
        return { r: 'stuck', why: '服务端防重放，伪造不可行' };
      }
      log('再等 60 秒开始正式上报…');
      await sleep(60000);
    }

    const t0 = Date.now();
    const limit = CFG.MAX_TASK_MIN * 60000;

    while (playing < dur) {
      if (Date.now() - t0 > limit) return { r: 'timeout', why: '加速上报超时' };
      if (!STATE.running) return { r: 'stuck', why: '已手动停止' };

      playing = Math.min(playing + step, dur);
      const r = await fakeBeat(job.jobid, playing);

      if (!r.ok) {
        log(`服务端拒收 @${Math.floor(playing)}s → ${r.reason}`);
        ACCEL.enabled = false;
        syncAccelUI();   // 连续失败时自动关掉加速，不再让后续章节重复尝试
        return { r: 'stuck', why: '被拒: ' + r.reason };
      }

      STATE.phase = `加速上报 ${fmt(playing)}/${fmt(dur)}`;
      paintState();
      log(`加速 ${fmt(playing)}/${fmt(dur)}`);

      if (playing >= dur) break;
      await sleep(60000);
    }

    await sleep(3000);
    const beforeDone = jobCounters().done;
    await reloadCards();
    await sleep(3000);
    const c = jobCounters();
    if (c.done > beforeDone) return { r: 'done' };
    const again = videoJobs().find((j) => j.jobid === job.jobid);
    if (again && again.done) return { r: 'done' };
    if (c.all > 0 && c.done >= c.all) return { r: 'done' };
    return { r: 'stuck', why: `上报满了但服务端未标记（完成数 ${beforeDone}→${c.done}）` };
  }

  async function runStudy() {
    if (STATE.running) {
      log('⚠️ 已经在运行中（如果没动静，点「停止」再点「开始」）');
      return;
    }
    if (!inWorkWindow()) { STATE.phase = `不在时段 ${CFG.HOUR_START}-${CFG.HOUR_END}`; paintState(); return; }

    setRunIntent(true);
    STATE.running = true; STATE.err = false; STATE.done = 0; STATE.userStopped = false; STATE.reviveCount = 0;
    STATE.phase = '启动中…';
    paintState();
    const RETRY = new Map();
    let failStreak = 0;   // 连续失败的章节数
    log('开始运行');

    try {
      const catOk = await waitFor(() => chapterEls().length > 0, 25000, 800);
      if (!catOk) {
        log('⚠️ 左侧目录还没加载出来');
        log('先点一下左侧任意章节，等目录出现后再点「开始」');
        STATE.phase = '目录未加载';
        return;
      }
      const list = chapters();
      if (!list.length) { STATE.phase = '目录为空'; return; }

      const todo = list.filter((c) => c.left > 0);
      STATE.total = todo.length;
      log(`目录 ${list.length} 章，有任务 ${todo.length} 章`);
      if (!todo.length) { STATE.phase = '全部完成'; return; }

      for (let i = 0; i < todo.length; i++) {
        if (!STATE.running) break;
        if (!inWorkWindow()) { STATE.phase = '超时段停止'; break; }

        const ch = todo[i];
        log(`=== ${i + 1}/${todo.length} ${ch.no} ${ch.title}`);

        stopKeepReading();

        if (H.chapter() !== ch.id) {
          if (!(await gotoChapter(ch.id))) {
            const b = blocked();
            if (b) {
              STATE.phase = `卡在 ${b}`;
              STATE.err = true;
              STATE.running = false;
              break;
            }
            failStreak++;
            log(`⚠️ 切章节失败 ${ch.id}，跳过（连续失败 ${failStreak}/3）`);
            STATE.phase = `跳过 ${ch.no}`;
            if (failStreak >= 3) { STATE.phase = '连续 3 章失败，停止'; STATE.running = false; break; }
            continue;
          }
        }

        const c0 = await waitFor(() => { const c = jobCounters(); return c.all > 0 ? c : null; }, 20000, 600);
        if (!c0) { log('无任务点，跳过'); continue; }
        log(`任务点 共${c0.all} 完${c0.done} 视频${c0.video}`);

        let idleSince = 0, guard = 0, lastReload = 0;

        while (STATE.running) {
          const b = blocked();
          if (b) { STATE.phase = `卡在 ${b}`; STATE.err = true; STATE.running = false; break; }

          const jobs = videoJobs();
          const next = jobs.find((j) => !j.done);

          if (!next) {
            const c = jobCounters();
            if (c.done >= c.all) {
              stopKeepReading();
              STATE.done++;   // done 按「章」计，与 total（章数）同口径，避免多视频章导致进度超 100%
              log(`本章完成 ${c.done}/${c.all}（${STATE.done}/${STATE.total} 章）`);
              break;
            }
            if (!idleSince) {
              idleSince = Date.now();
              lastReload = Date.now();
              if (READ.enabled) startReadSession(); else startKeepReading();
              log(`本章有 ${c.all - c.done} 个非视频任务点，等待完成…`);
              if (STATE.questions.length) {
                log('测验已自动填好 → 核对后点页面「提交」→ 再点面板「继续」');
              } else if (READ.enabled) {
                log(`阅读模式：慢速阅读中，等待窗口 ${READ.waitHours} 小时（阅读时长通常次日更新）`);
                log('阅读模式：不会自动刷新页面，避免打断计时');
              } else {
                log('文档类会自动模拟阅读，无需操作');
              }
            }
            const waited = Date.now() - idleSince;
            const waitMs = READ.enabled ? READ.waitHours * 3600000 : CFG.WORK_WAIT_MIN * 60000;
            if (waited > waitMs) {
              STATE.phase = READ.enabled ? `阅读等待超时（${READ.waitHours}小时）` : `等待超时（${CFG.WORK_WAIT_MIN}分）`;
              STATE.err = true; STATE.running = false; break;
            }
            STATE.phase = READ.enabled
              ? `阅读中 ${(waited / 3600000).toFixed(1)} 小时（次日更新）`
              : `等待中 ${Math.floor(waited / 60000)} 分`;
            paintState();

            if (READ.enabled) {
              // 阅读模式：绝不自动重载，重建 iframe 会打断阅读计时
              await sleep(30000);
            } else if (!STATE.questions.length && Date.now() - lastReload > 300000) {
              // 有测验时绝不自动重载（会打断输入），等用户点「继续」
              lastReload = Date.now();
              await reloadCards();
            } else {
              await sleep(8000);
            }
            continue;
          }

          idleSince = 0;
          if (++guard > 100) { log('本章循环过多，跳到下一章'); break; }

          const res = ACCEL.enabled ? await runOneAccel(next) : await runOneVideo(next);
          log(`结果 ${res.r}${res.why ? ' - ' + res.why : ''}`);

          if (res.r === 'done') {
            failStreak = 0;          // 成功一次就重置失败计数（进度按章计，在整章完成时累加）
            await reloadCards();
            continue;
          }

          if (res.r === 'aborted') {
            STATE.phase = '手动停止';
            STATE.running = false;
            break;
          }

          if (res.r === 'retry') {
            const n = (RETRY.get(next.jobid) || 0) + 1;
            RETRY.set(next.jobid, n);
            if (n > 3) { STATE.phase = `放弃 ${next.jobid}`; STATE.err = true; STATE.running = false; break; }
            STATE.phase = `重试 ${n}/3`;
            log(`等 ${60 * n} 秒重试`);
            paintState();
            await sleep(60 * n * 1000);
            await reloadCards();
            continue;
          }

          // 不可恢复的拦截：必须停机
          if (res.r === 'blocked') {
            STATE.phase = `卡在 ${res.why}`;
            STATE.err = true;
            STATE.running = false;
            break;
          }

          // 其他失败（stuck / timeout）：跳过本章，继续下一章
          failStreak++;
          STATE.err = true;
          STATE.phase = `跳过本章（${res.why || res.r}）`;
          log(`⚠️ 本章卡住，跳过继续（连续失败 ${failStreak}/3）`);
          if (failStreak >= 3) {
            STATE.phase = '连续 3 章失败，停止';
            STATE.running = false;
            log('连续 3 章失败，建议检查日志后手动处理');
          }
          break;   // 只跳出本章，外层继续下一章
        }
      }
      if (STATE.running) STATE.phase = '本轮跑完';
    } catch (e) {
      log('异常：' + e.message);
      STATE.phase = '异常：' + e.message;
      STATE.err = true;
    } finally {
      STATE.running = false;
      stopKeepReading();
      // 能走到 finally，说明这一轮确实结束了（跑完/手动停/报错停），清掉运行意图。
      // 整页重载时 JS 上下文被销毁、finally 不会执行，意图得以保留供 boot 续跑。
      setRunIntent(false);
      paintState();
    }
  }

  // ==================== 面板 ====================
  function updateBadges() {
    const b1 = $('#cx-badge-study');
    if (b1) b1.textContent = STATE.total ? `${STATE.done}/${STATE.total}章` : (STATE.running ? '运行中' : '—');

    const b2 = $('#cx-badge-work');
    if (b2) b2.textContent = STATE.questions.length ? `${STATE.questions.length} 题` : '—';

    const b3 = $('#cx-badge-set');
    if (b3) {
      const arr = [];
      if (loadTiku().url) arr.push('题库');
      if (aiReady()) arr.push('AI');
      b3.textContent = arr.join('+') || '未配置';
      b3.style.color = arr.length ? '#4cc38a' : '#85858b';
    }
  }

  function paintState() {
    const st = $('#cx-state');
    if (st) {
      st.textContent = STATE.phase;
      st.style.color = STATE.err ? '#e5484d' : (STATE.running ? '#4cc38a' : '#a1a1a6');
    }
    const dot = $('#cx-dot');
    if (dot) dot.style.background = STATE.err ? '#e5484d' : (STATE.running ? '#4cc38a' : '#85858b');

    const bar = $('#cx-bar');
    if (bar) {
      const pct = STATE.total ? Math.min(100, Math.round((STATE.done / STATE.total) * 100)) : 0;
      bar.style.width = pct + '%';
    }

    // 按钮状态跟随运行状态
    const runBtn = $('#cx-run');
    if (runBtn) {
      if (STATE.running) {
        // 运行中：中性表面 + 弱化文字，表示当前不可再点「开始」
        runBtn.textContent = '运行中…';
        runBtn.style.background = '#232325';
        runBtn.style.color = '#85858b';
        runBtn.style.borderColor = 'rgba(237,237,237,.12)';
        runBtn.style.cursor = 'not-allowed';
      } else {
        runBtn.textContent = '开始';
        runBtn.style.background = '';
        runBtn.style.color = '';
        runBtn.style.borderColor = '';
        runBtn.style.cursor = 'pointer';
      }
    }
    const stopBtn = $('#cx-stop');
    if (stopBtn) {
      // 停止是运行中唯一可执行的操作，用 toned 语义红，不额外变亮
      stopBtn.style.background = STATE.running ? '#3a2022' : '';
      stopBtn.style.color = STATE.running ? '#e5484d' : '';
      stopBtn.style.borderColor = STATE.running ? 'rgba(229,72,77,.35)' : '';
    }

    updateBadges();
  }

  // 题目渲染指纹：题目集合没变就不重建 DOM，避免清掉用户正在输入的答案和滚动位置
  let workRenderSig = '';

  function refreshWork() {
    if (STATE.aiBusy) return;   // 答题进行中冻结测验区，保证 aiAnswerAll 的题目快照与面板 DOM 稳定
    const host = $('#cx-work-host');
    if (!host) return;

    const doc = findWorkDoc();
    STATE.workDoc = doc;

    if (!doc) {
      host.innerHTML = `<div class="cx-empty">当前页面没有测验</div>`;
      STATE.questions = [];
      workRenderSig = '';
      updateBadges();
      return;
    }

    // 只解密一次
    if (!doc.__cxDecrypted) {
      const dec = decryptIn(doc);
      doc.__cxDecrypted = dec;
      if (dec.ok && dec.replaced) log(`字体解密：还原 ${dec.replaced} 字`);
      else if (!dec.ok) log('字体解密失败：' + dec.note);
    }

    const fresh = parseWork(doc);
    // 指纹只由题目本身决定（不含已填答案），答案变化不触发重建
    const sig = fresh.map((q) => `${q.idx}|${q.kind}|${q.stem}`).join('\u0001');
    if (sig === workRenderSig && host.querySelector('.cx-q')) {
      // 题目没变：只更新每题的「当前答案」显示，绝不碰输入框和滚动位置
      fresh.forEach((q) => {
        const row = host.querySelector(`.cx-q[data-idx="${q.idx}"]`);
        const cur = row && row.querySelector('.cx-cur');
        if (cur) {
          const v = curAnswer(q) || '—';
          if (cur.textContent !== v) cur.textContent = v;
        }
      });
      STATE.questions = fresh;
      updateBadges();
      return;
    }
    workRenderSig = sig;
    STATE.questions = fresh;
    const qs = STATE.questions;
    if (!qs.length) {
      host.innerHTML = `<div class="cx-empty">没解析到题目</div>`;
      updateBadges();
      return;
    }

    const bank = loadBank();
    const rows = qs.map((q) => {
      const tn = { multi: '多选', single: '单选', blank: '填空' }[q.kind] || q.kind;
      const known = bank[fp(q)];
      const opts = q.opts.length
        ? q.opts.map((o) => `<div class="cx-opt">${o.key}. ${esc(o.text)}</div>`).join('')
        : `<div class="cx-opt">${q.editors.length} 个空（多个用 | 分隔）</div>`;
      const cur = curAnswer(q);
      return `
        <div class="cx-q" data-idx="${q.idx}">
          <div class="cx-q-hd">
            <span class="cx-q-no">${q.idx + 1}</span>
            <span class="cx-q-type">${tn}</span>
            ${known ? '<span class="cx-tag">库</span>' : ''}
            <span class="cx-cur curv">${esc(cur || '—')}</span>
          </div>
          <div class="cx-stem">${esc(q.stem.slice(0, 200))}</div>
          ${opts}
          <input class="cx-ans ansinp" data-idx="${q.idx}" value="${known ? esc(known) : ''}"
            placeholder="${q.kind === 'blank' ? '答案1|答案2' : '字母'}" />
        </div>`;
    }).join('');

    host.innerHTML = `<div style="max-height:36vh;overflow:auto;margin:0 -1px">${rows}</div>`;
    updateBadges();

    // 自动答题：只在页面全空白时触发，不重复打扰
    setTimeout(() => { try { maybeAutoAnswer(); } catch (e) {} }, 800);
  }

  // 把已保存的配置回填进输入框，不改折叠状态（启动时也会调用）
  function fillSettings() {
    const ai = loadAI();
    const tk = loadTiku();
    const tu = $('#cx-tiku-url'); if (tu) tu.value = tk.url || '';
    const au = $('#cx-ai-url'); if (au) au.value = ai.url || '';
    const ak = $('#cx-ai-key'); if (ak) ak.value = ai.key || '';
    const am = $('#cx-ai-model'); if (am) am.value = ai.model || '';
  }

  function openSettings() {
    const sec = document.getElementById('cx-sec-set');
    if (sec) sec.classList.remove('collapsed');
    fillSettings();
  }

  function injectStyle() {
    if (document.getElementById('cx-style')) return;
    const st = document.createElement('style');
    st.id = 'cx-style';
    st.textContent = `
/* 中性石墨色阶：表面、边框、文字三档来自同一 ramp；唯一强调色为钴蓝，仅用于主操作与进度 */
#cx-panel{--cx-btn-scale:1;position:fixed;right:16px;top:16px;width:380px;max-height:90vh;display:flex;flex-direction:column;
  z-index:2147483647;background:#141415;border:1px solid rgba(237,237,237,.10);border-radius:14px;
  box-shadow:0 16px 48px rgba(0,0,0,.5);color:#ededed;
  font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
#cx-panel .cx-hd{display:flex;align-items:center;gap:8px;padding:12px 16px;
  background:#1a1a1c;border-bottom:1px solid rgba(237,237,237,.08);cursor:move;user-select:none}
#cx-panel .cx-dot{width:8px;height:8px;border-radius:50%;background:#85858b;flex:0 0 auto;
  transition:background .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-title{font-weight:500;font-size:13px;flex:1}
#cx-panel .cx-icon{width:24px;height:24px;display:flex;align-items:center;justify-content:center;
  border-radius:6px;cursor:pointer;color:#85858b;font-size:14px;line-height:1;
  transition:background .15s cubic-bezier(.22,1,.36,1),color .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-icon:hover{background:#232325;color:#ededed}
#cx-panel .cx-body{overflow-y:auto;overflow-x:hidden;flex:1}
#cx-panel .cx-body::-webkit-scrollbar{width:8px}
#cx-panel .cx-body::-webkit-scrollbar-thumb{background:#2a2a2d;border-radius:4px}
#cx-panel .cx-sec{border-bottom:1px solid rgba(237,237,237,.07)}
#cx-panel .cx-sec:last-child{border-bottom:none}
#cx-panel .cx-sec-hd{display:flex;align-items:center;gap:8px;padding:8px 16px;cursor:pointer;user-select:none}
#cx-panel .cx-sec-hd:hover{background:#1a1a1c}
#cx-panel .cx-sec-title{font-size:11px;color:#a1a1a6;font-weight:400}
#cx-panel .cx-sec-badge{font-size:10px;color:#85858b;margin-left:auto;font-family:ui-monospace,monospace}
#cx-panel .cx-caret{font-size:9px;color:#85858b;transition:transform .15s cubic-bezier(.22,1,.36,1);display:inline-block}
#cx-panel .cx-sec.collapsed .cx-caret{transform:rotate(-90deg)}
#cx-panel .cx-sec.collapsed .cx-sec-body{display:none}
#cx-panel .cx-sec-body{padding:0 16px 12px}
#cx-panel .cx-state{font-size:12px;color:#a1a1a6;margin-bottom:8px;min-height:18px;line-height:1.5}
#cx-panel .cx-bar{height:4px;background:#262629;border-radius:2px;overflow:hidden;margin-bottom:12px}
#cx-panel .cx-bar-in{height:100%;width:0;background:#2563eb;
  transition:width .3s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-row{display:flex;gap:8px}
/* 开关子行：标签、状态值、紧凑输入、紧凑按钮 */
#cx-panel .cx-subrow{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;
  border-top:1px solid rgba(237,237,237,.07)}
#cx-panel .cx-k{font-size:11px;color:#85858b;white-space:nowrap}
#cx-panel .cx-kval{font-size:11px;color:#a1a1a6}
#cx-panel .cx-mini{width:44px;background:#0f0f10;color:#ededed;border:1px solid rgba(237,237,237,.12);
  border-radius:6px;padding:4px 6px;font-size:11px;outline:none;text-align:center;
  transition:border-color .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-mini:focus{border-color:#2563eb}
/* 勾选框行：原生 checkbox + 强调色，勾选=答完自动提交 */
#cx-panel .cx-check{display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:8px;
  border-top:1px solid rgba(237,237,237,.07);cursor:pointer;user-select:none;font-size:11px;color:#a1a1a6}
#cx-panel .cx-check input{width:15px;height:15px;margin:0;accent-color:#2563eb;cursor:pointer}
#cx-panel .cx-check:hover{color:#ededed}
#cx-panel .cx-btn.cx-mini-btn{flex:0 0 calc(64px * var(--cx-btn-scale));padding:calc(6px * var(--cx-btn-scale)) 0;
  font-size:calc(11px * var(--cx-btn-scale));margin-left:auto}
#cx-panel .cx-btn{flex:1;padding:calc(8px * var(--cx-btn-scale)) 0;border:1px solid transparent;
  border-radius:calc(8px * var(--cx-btn-scale));cursor:pointer;
  font-size:calc(12px * var(--cx-btn-scale));font-weight:500;color:#ededed;background:#232325;
  transition:background .15s cubic-bezier(.22,1,.36,1),border-color .15s cubic-bezier(.22,1,.36,1),opacity .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-btn:hover{background:#2d2d30}
#cx-panel .cx-btn:active{opacity:.8}
#cx-panel .cx-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
#cx-panel .cx-btn.primary:hover{background:#1d4fd0;border-color:#1d4fd0}
/* 次要操作统一为中性表面 + 发丝边框，不再各占一种彩色 */
#cx-panel .cx-btn.ok,#cx-panel .cx-btn.ai{background:#232325;border-color:rgba(237,237,237,.12);color:#ededed}
#cx-panel .cx-btn.ok:hover,#cx-panel .cx-btn.ai:hover{background:#2d2d30;border-color:rgba(237,237,237,.2)}
#cx-panel .cx-q{border-top:1px solid rgba(237,237,237,.07);padding:12px 0}
#cx-panel .cx-q:first-child{border-top:none;padding-top:0}
#cx-panel .cx-q-hd{display:flex;align-items:center;gap:8px;margin-bottom:4px}
#cx-panel .cx-q-no{color:#a1a1a6;font-weight:500;font-size:12px}
#cx-panel .cx-q-type{color:#85858b;font-size:10px;padding:2px 6px;background:#232325;border-radius:4px}
#cx-panel .cx-tag{font-size:10px;padding:2px 6px;border-radius:4px;background:#1a2b22;color:#4cc38a}
#cx-panel .cx-cur{margin-left:auto;color:#4cc38a;font-size:11px;font-family:ui-monospace,monospace}
#cx-panel .cx-stem{font-size:12px;line-height:1.6;color:#ededed;margin-bottom:4px;word-break:break-all}
#cx-panel .cx-opt{font-size:11px;line-height:1.6;color:#a1a1a6;padding-left:8px;word-break:break-all}
#cx-panel .cx-ans{width:100%;box-sizing:border-box;margin-top:8px;background:#0f0f10;color:#ededed;
  border:1px solid rgba(237,237,237,.12);border-radius:8px;padding:8px 12px;
  font:12px ui-monospace,Consolas,monospace;outline:none;
  transition:border-color .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-ans:focus{border-color:#2563eb}
#cx-panel .cx-log{font:11px/1.6 ui-monospace,Consolas,monospace;color:#85858b;
  white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto}
#cx-panel .cx-log::-webkit-scrollbar{width:8px}
#cx-panel .cx-log::-webkit-scrollbar-thumb{background:#2a2a2d;border-radius:4px}
#cx-panel .cx-lbl{font-size:10px;color:#85858b;margin:8px 0 4px}
#cx-panel .cx-inp{width:100%;box-sizing:border-box;margin-bottom:8px;background:#0f0f10;color:#ededed;
  border:1px solid rgba(237,237,237,.12);border-radius:8px;padding:8px 12px;font-size:12px;outline:none;
  transition:border-color .15s cubic-bezier(.22,1,.36,1)}
#cx-panel .cx-inp:focus{border-color:#2563eb}

/* 浮动标签输入框 */
#cx-panel .cx-group{margin:16px 0 0}
#cx-panel .cx-group-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
#cx-panel .cx-group-name{font-size:12px;color:#ededed;font-weight:500}
#cx-panel .cx-group-tag{font-size:10px;color:#85858b;background:#232325;padding:2px 8px;border-radius:4px}
#cx-panel .cx-field{position:relative;margin-bottom:12px}
#cx-panel .cx-field input{width:100%;box-sizing:border-box;background:#0f0f10;color:#ededed;
  border:1px solid rgba(237,237,237,.12);border-radius:8px;padding:20px 12px 8px;font-size:12px;outline:none;
  transition:border-color .15s cubic-bezier(.22,1,.36,1),background .15s cubic-bezier(.22,1,.36,1);font-family:inherit}
#cx-panel .cx-field input:hover{border-color:rgba(237,237,237,.2)}
#cx-panel .cx-field input:focus{border-color:#2563eb;background:#0b0b0d}
#cx-panel .cx-field label{position:absolute;left:12px;top:12px;font-size:11px;color:#85858b;
  pointer-events:none;
  transition:top .15s cubic-bezier(.22,1,.36,1),font-size .15s cubic-bezier(.22,1,.36,1),color .15s cubic-bezier(.22,1,.36,1);
  transform-origin:left top}
#cx-panel .cx-field input:focus+label,
#cx-panel .cx-field input:not(:placeholder-shown)+label{top:4px;font-size:10px;color:#a1a1a6}
#cx-panel .cx-field input:focus+label{color:#5b9bf5}
#cx-panel .cx-hint{font-size:10px;color:#85858b;line-height:1.6;margin:0 0 8px}
#cx-panel .cx-reveal{position:absolute;right:12px;top:12px;cursor:pointer;color:#85858b;font-size:11px;
  padding:2px 6px;border-radius:4px}
#cx-panel .cx-reveal:hover{color:#ededed;background:#232325}
#cx-panel .cx-empty{color:#85858b;padding:12px 0;text-align:center;font-size:11px}
#cx-panel.mini .cx-body{display:none}
#cx-panel.mini .cx-hd{border-bottom:none}
#cx-reopen{position:fixed;right:16px;top:16px;z-index:2147483646;padding:8px 16px;border-radius:8px;
  border:1px solid rgba(237,237,237,.1);background:#1a1a1c;color:#ededed;
  font:500 12px/1 system-ui,sans-serif;cursor:pointer;
  box-shadow:0 8px 24px rgba(0,0,0,.45);user-select:none;
  transition:background .15s cubic-bezier(.22,1,.36,1)}
#cx-reopen:hover{background:#232325}
`;
    document.head.appendChild(st);
  }

  function buildPanel() {
    if (panel) return;
    injectStyle();

    panel = document.createElement('div');
    panel.id = 'cx-panel';

    panel.innerHTML = `
      <div class="cx-hd" id="cx-drag">
        <span class="cx-dot" id="cx-dot"></span>
        <span class="cx-title">学习通助手</span>
        <span class="cx-icon" id="cx-min" title="最小化">—</span>
        <span class="cx-icon" id="cx-x" title="关闭">×</span>
      </div>

      <div class="cx-body" id="cx-body">
        <div class="cx-sec" id="cx-sec-study">
          <div class="cx-sec-hd" data-toggle="cx-sec-study">
            <span class="cx-caret">▼</span><span class="cx-sec-title">刷课</span>
            <span class="cx-sec-badge" id="cx-badge-study">—</span>
          </div>
          <div class="cx-sec-body">
            <div class="cx-state" id="cx-state">待启动</div>
            <div class="cx-bar"><div class="cx-bar-in" id="cx-bar"></div></div>
            <div class="cx-row">
              <button class="cx-btn primary" id="cx-run">开始</button>
              <button class="cx-btn ok" id="cx-resume">继续</button>
              <button class="cx-btn" id="cx-diag">诊断</button>
              <button class="cx-btn" id="cx-stop">停止</button>
            </div>
            <div class="cx-subrow">
              <span class="cx-k">加速</span>
              <span id="cx-accel-state" class="cx-kval">关闭</span>
              <span id="cx-speed-wrap" style="display:none;align-items:center;gap:4px">
                <span class="cx-k">×</span>
                <input id="cx-speed" class="cx-mini" type="number" step="0.1" min="0.5" max="5" value="1.2" />
              </span>
              <button class="cx-btn cx-mini-btn" id="cx-accel">开启</button>
            </div>
            <div class="cx-subrow">
              <span class="cx-k">阅读模式</span>
              <span id="cx-read-state" class="cx-kval">关闭</span>
              <span id="cx-read-hours-wrap" style="display:none;align-items:center;gap:4px">
                <span class="cx-k">等</span>
                <input id="cx-read-hours" class="cx-mini" type="number" min="1" max="72" step="1" value="26" />
                <span class="cx-k">小时</span>
              </span>
              <button class="cx-btn cx-mini-btn" id="cx-read-toggle">开启</button>
            </div>
          </div>
        </div>

        <div class="cx-sec" id="cx-sec-work">
          <div class="cx-sec-hd" data-toggle="cx-sec-work">
            <span class="cx-caret">▼</span><span class="cx-sec-title">测验</span>
            <span class="cx-sec-badge" id="cx-badge-work">—</span>
          </div>
          <div class="cx-sec-body">
            <div id="cx-work-host"><div class="cx-empty">检测中…</div></div>
            <div class="cx-row" style="margin-top:12px">
              <button class="cx-btn primary" id="cx-ai">智能答题</button>
            </div>
            <div class="cx-row" style="margin-top:8px">
              <button class="cx-btn" id="cx-fill">填充</button>
              <button class="cx-btn" id="cx-bank">存库</button>
              <button class="cx-btn" id="cx-clear">清空</button>
            </div>
            <div class="cx-subrow">
              <span class="cx-k">答题停顿</span>
              <input id="cx-ans-delay" class="cx-mini" type="number" min="0" max="60" step="1" value="8" />
              <span class="cx-k">秒/题，避免过快</span>
            </div>
            <label class="cx-check" for="cx-autosub">
              <input type="checkbox" id="cx-autosub" />
              <span>答完自动提交（不勾则自己在页面提交）</span>
            </label>
          </div>
        </div>

        <div class="cx-sec collapsed" id="cx-sec-set">
          <div class="cx-sec-hd" data-toggle="cx-sec-set">
            <span class="cx-caret">▼</span><span class="cx-sec-title">设置</span>
            <span class="cx-sec-badge" id="cx-badge-set"></span>
          </div>
          <div class="cx-sec-body">

            <div class="cx-group" style="margin-top:0">
              <div class="cx-group-hd">
                <span class="cx-group-name">按钮大小</span>
                <span class="cx-group-tag" id="cx-scale-val">100%</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <span class="cx-k">小</span>
                <input id="cx-btn-scale" type="range" min="0.75" max="1.5" step="0.05" value="1"
                  style="flex:1;accent-color:#2563eb;cursor:pointer;height:4px" />
                <span class="cx-k">大</span>
              </div>
              <div class="cx-hint">拖动实时改变面板按钮大小，自动保存</div>
            </div>

            <div class="cx-group">
              <div class="cx-group-hd">
                <span class="cx-group-name">题库</span>
                <span class="cx-group-tag">可选</span>
              </div>
              <div class="cx-field">
                <input id="cx-tiku-url" placeholder=" " spellcheck="false" />
                <label>服务地址</label>
              </div>
              <div class="cx-hint">本地跑 tikuAdapter 后填 http://localhost:8060/adapter-service/search<br>不填则跳过题库，只用 AI</div>
            </div>

            <div class="cx-group">
              <div class="cx-group-hd">
                <span class="cx-group-name">AI 大模型</span>
                <span class="cx-group-tag">可选</span>
              </div>
              <div class="cx-field">
                <input id="cx-ai-url" placeholder=" " spellcheck="false" />
                <label>API 地址</label>
              </div>
              <div class="cx-field">
                <input id="cx-ai-key" type="password" placeholder=" " autocomplete="off" spellcheck="false" />
                <label>API Key</label>
                <span class="cx-reveal" id="cx-key-eye">显示</span>
              </div>
              <div class="cx-field">
                <input id="cx-ai-model" placeholder=" " spellcheck="false" />
                <label>模型名</label>
              </div>
              <div class="cx-hint">三项都必填。留空表示不使用 AI<br>用 DeepSeek 可点下方按钮自动填地址和模型</div>
            </div>

            <button class="cx-btn primary" id="cx-ai-save" style="width:100%;margin-top:12px">保存</button>
            <button class="cx-btn" id="cx-ai-preset" style="width:100%;margin-top:8px">填入 DeepSeek 默认地址</button>
          </div>
        </div>

        <div class="cx-sec collapsed" id="cx-sec-log">
          <div class="cx-sec-hd" data-toggle="cx-sec-log">
            <span class="cx-caret">▼</span><span class="cx-sec-title">日志</span>
            <span class="cx-sec-badge" id="cx-badge-log"></span>
          </div>
          <div class="cx-sec-body">
            <div class="cx-log" id="cx-log"></div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(panel);

    // 折叠
    panel.querySelectorAll('[data-toggle]').forEach((hd) => {
      hd.onclick = () => {
        const sec = document.getElementById(hd.dataset.toggle);
        if (sec) sec.classList.toggle('collapsed');
      };
    });

    // 拖动
    (function makeDraggable() {
      const hd = document.getElementById('cx-drag');
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      hd.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('cx-icon')) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        panel.style.right = 'auto';
        panel.style.left = r.left + 'px';
        panel.style.top = r.top + 'px';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    })();

    // 最小化 / 关闭。关闭后留一个悬浮小按钮用于恢复，避免误关后只能刷新页面（会丢进度和日志）
    $('#cx-min').onclick = () => panel.classList.toggle('mini');
    let reopenBtn = null;
    $('#cx-x').onclick = () => {
      panel.style.display = 'none';
      if (!reopenBtn) {
        reopenBtn = document.createElement('div');
        reopenBtn.id = 'cx-reopen';
        reopenBtn.textContent = '助手';
        reopenBtn.title = '重新打开面板';
        document.body.appendChild(reopenBtn);
        reopenBtn.onclick = () => {
          panel.style.display = '';
          if (reopenBtn) { reopenBtn.remove(); reopenBtn = null; }
          renderLog();
        };
      }
    };

    // 设置
    $('#cx-key-eye').onclick = () => {
      const k = $('#cx-ai-key');
      if (!k) return;
      const show = k.type === 'password';
      k.type = show ? 'text' : 'password';
      $('#cx-key-eye').textContent = show ? '隐藏' : '显示';
    };

    $('#cx-ai-preset').onclick = () => {
      const au = $('#cx-ai-url');
      const am = $('#cx-ai-model');
      if (au && !au.value.trim()) au.value = 'https://api.deepseek.com/chat/completions';
      if (am && !am.value.trim()) am.value = 'deepseek-chat';
      log('已填入默认地址和模型，别忘了填 API Key 再点保存');
    };

    $('#cx-ai-save').onclick = () => {
      const btn = $('#cx-ai-save');
      try {
        const tkUrl = ($('#cx-tiku-url') || {}).value ? $('#cx-tiku-url').value.trim() : '';
        const aiUrl = $('#cx-ai-url').value.trim();
        const aiKey = $('#cx-ai-key').value.trim();
        const aiModel = $('#cx-ai-model').value.trim();

        const ok1 = saveTiku({ url: tkUrl });
        const ok2 = saveAI({ url: aiUrl, key: aiKey, model: aiModel });

        // 回读验证
        const t2 = loadTiku();
        const a2 = loadAI();
        const tkOk = (t2.url || '') === tkUrl;
        const keyOk = (a2.key || '') === aiKey;
        const urlOk = (a2.url || '') === aiUrl;
        const mdOk = (a2.model || '') === aiModel;

        if (tkOk && keyOk && urlOk && mdOk) {
          log('配置已保存并校验通过');
          if (btn) {
            btn.textContent = '已保存';
            btn.style.background = '#1a4d35';
            btn.style.borderColor = '#1a4d35';
            setTimeout(() => { btn.textContent = '保存'; btn.style.background = ''; btn.style.borderColor = ''; }, 1600);
          }
        } else {
          log('保存后回读不一致 — 题库:' + tkOk + ' 地址:' + urlOk + ' Key:' + keyOk + ' 模型:' + mdOk);
          if (btn) { btn.textContent = '保存失败'; btn.style.background = '#5c2628'; btn.style.borderColor = '#5c2628'; }
        }
        updateBadges();
      } catch (e) {
        log('保存异常: ' + e.message);
        if (btn) { btn.textContent = '保存异常'; btn.style.background = '#5c2628'; btn.style.borderColor = '#5c2628'; }
      }
    };

    $('#cx-run').onclick = () => runStudy();
    $('#cx-stop').onclick = () => {
      setRunIntent(false);
      STATE.running = false;
      STATE.userStopped = true;
      STATE.err = false;
      STATE.phase = '手动停止';
      stopKeepReading();
      // 真正把视频停下来
      let n = 0;
      try {
        for (const j of videoJobs()) {
          const v = videoEl(j.frame);
          if (v) { try { v.pause(); n++; } catch (e) {} }
        }
      } catch (e) {}
      paintState();
      log(`已停止${n ? `（暂停了 ${n} 个视频）` : ''}`);
    };

    // 加速模式：确认弹窗
    function updateAccelUI() {
      const st = $('#cx-accel-state');
      const btn = $('#cx-accel');
      const wrap = $('#cx-speed-wrap');
      if (st) {
        st.textContent = ACCEL.enabled ? '开启中' : '关闭';
        st.style.color = ACCEL.enabled ? '#5b9bf5' : '#85858b';
      }
      if (btn) btn.textContent = ACCEL.enabled ? '关闭' : '开启';
      if (wrap) wrap.style.display = ACCEL.enabled ? 'flex' : 'none';
      const sp = $('#cx-speed');
      if (sp && !sp.dataset.init) { sp.value = String(ACCEL.speed); sp.dataset.init = '1'; }
    }

    $('#cx-speed').onchange = () => {
      const el = $('#cx-speed');
      const v = parseFloat(el.value);
      if (!(v >= 0.5) || v > 5) {
        el.value = String(ACCEL.speed);
        log('倍速要在 0.5 ~ 5 之间');
        return;
      }
      ACCEL.speed = v;
      savePrefs();
      log('加速倍速设为 ×' + v + '（下一条视频生效）');
    };

    function showAccelConfirm() {
      const m = document.createElement('div');
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2147483648;' +
        'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';
      m.innerHTML = `
        <div style="background:#141415;border:1px solid rgba(237,237,237,.10);border-radius:14px;padding:20px 20px;
          width:328px;box-shadow:0 24px 64px rgba(0,0,0,.55);font:12px/1.6 system-ui,sans-serif;color:#ededed">
          <div style="font-size:13px;font-weight:500;margin-bottom:12px">开启加速模式</div>
          <div style="color:#a1a1a6;font-size:12px;line-height:1.6;margin-bottom:16px">
            开启后不再真实播放，改为伪造心跳上报。<br>
            <div style="margin-top:8px;color:#ededed">
              · 每个视频仍需真实播放约 60 秒预热<br>
              · 之后按设定倍速伪造上报<br>
              · 随时可点「关闭」回到真实播放
            </div>
            <div style="margin-top:12px;padding:8px 12px;background:#241a1b;border-left:2px solid #e5484d;border-radius:4px;color:#c9a9aa">
              当前版本服务端会拒：同一进度点重复上报会被判定无效，只改时间戳也拒。开启后大概率白等。
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button id="cx-ac-no" style="flex:1;padding:8px;border:1px solid rgba(237,237,237,.12);border-radius:8px;background:#232325;color:#ededed;cursor:pointer;font-size:12px">取消</button>
            <button id="cx-ac-yes" style="flex:1;padding:8px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:500">确认开启</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('#cx-ac-no').onclick = () => m.remove();
      m.querySelector('#cx-ac-yes').onclick = () => {
        m.remove();
        ACCEL.enabled = true;
        updateAccelUI();
        if (STATE.running) {
          log('⚠️ 加速模式已开启，当前这条播完后自动生效');
          log('（想立刻切换：点「停止」→ 再点「开始」）');
        } else {
          log('⚠️ 加速模式已开启，点「开始」后生效');
        }
      };
    }

    syncAccelUI = updateAccelUI;
    $('#cx-accel').onclick = () => {
      if (ACCEL.enabled) {
        ACCEL.enabled = false;
        updateAccelUI();
        log('已关闭加速模式，恢复真实播放');
      } else {
        showAccelConfirm();
      }
    };
    updateAccelUI();

    // 阅读模式开关
    function updateReadUI() {
      const st = $('#cx-read-state');
      const btn = $('#cx-read-toggle');
      const wrap = $('#cx-read-hours-wrap');
      if (st) {
        st.textContent = READ.enabled ? '开启中' : '关闭';
        st.style.color = READ.enabled ? '#5b9bf5' : '#85858b';
      }
      if (btn) btn.textContent = READ.enabled ? '关闭' : '开启';
      if (wrap) wrap.style.display = READ.enabled ? 'flex' : 'none';
    }
    const hoursEl = $('#cx-read-hours');
    if (hoursEl) {
      hoursEl.value = String(READ.waitHours);   // 回填已保存的值
      hoursEl.onchange = () => {
        const v = parseFloat(hoursEl.value);
        if (!(v >= 1) || v > 72) {
          hoursEl.value = String(READ.waitHours);
          log('阅读等待要在 1 ~ 72 小时之间');
          return;
        }
        READ.waitHours = v;
        savePrefs();
        log(`阅读等待窗口设为 ${v} 小时`);
      };
    }
    $('#cx-read-toggle').onclick = () => {
      READ.enabled = !READ.enabled;
      updateReadUI();
      if (READ.enabled && STATE.running) {
        stopKeepReading();
        startReadSession();
        log('阅读模式已开启，当前等待中的文档改慢速阅读、不再自动刷新');
      } else if (READ.enabled) {
        log('阅读模式已开启，点「开始」后生效（读完后服务端通常次日记账）');
      } else {
        stopKeepReading();
        log('阅读模式已关闭，恢复默认模拟阅读');
      }
    };
    updateReadUI();

    $('#cx-resume').onclick = async () => {
      log('刷新任务页…');
      const ok = await reloadCards();
      refreshWork();
      log(ok ? '刷新完成，等待任务点状态更新；测验需先在页面点「提交」' : '刷新未完成（找不到任务 iframe）');
    };
    $('#cx-diag').onclick = () => {
      log('────── 诊断 ' + new Date().toLocaleTimeString().slice(0, 5) + ' ──────');
      log(`章节=${H.chapter()} 课程=${H.course()}`);
      const cs = chapters();
      log(`目录 ${cs.length} 章`);
      cs.slice(0, 8).forEach((c) => log(`  ${c.no} ${c.title} 未完${c.left}`));
      const c = jobCounters();
      log(`任务点 共${c.all} 完${c.done} 视频${c.video}`);
      const wd = findWorkDoc();
      log('测验文档: ' + (wd ? '找到，' + parseWork(wd).length + ' 题' : '无'));
    };

    $('#cx-fill').onclick = () => {
      if (!STATE.workDoc) { log('没有测验'); return; }
      let ok = 0, bad = 0;
      $$('#cx-panel .ansinp').forEach((inp) => {
        const i = +inp.dataset.idx;
        const v = inp.value.trim();
        if (!v) return;
        const q = STATE.questions.find((x) => x.idx === i);
        if (!q) return;
        const r = fillOne(q, v);
        if (r.ok) { ok++; log(`第${i + 1}题 ✅ ${r.now}${r.how ? ' [' + r.how + ']' : ''}`); }
        else { bad++; log(`第${i + 1}题 ❌ 期望${v} 实际${r.now}`); }
      });
      refreshWork();
      log(`填充 ${ok} 成功 / ${bad} 失败`);
    };

    $('#cx-ai').onclick = () => aiAnswerAll();

    // 答完自动提交勾选框：勾上=AI 答完且无留空时自动交卷；不勾=自己去页面提交
    const autoCb = $('#cx-autosub');
    if (autoCb) {
      autoCb.checked = CFG.AUTO_SUBMIT;
      autoCb.onchange = () => {
        CFG.AUTO_SUBMIT = autoCb.checked;
        savePrefs();
        log(CFG.AUTO_SUBMIT
          ? '已勾选「答完自动提交」：题目全部答完且无留空时自动交卷'
          : '已取消「答完自动提交」：答完后请自己在页面提交');
      };
    }

    // 按钮大小滑块：改 CSS 变量，实时缩放所有按钮，并持久化
    const scaleEl = $('#cx-btn-scale');
    if (scaleEl) {
      scaleEl.value = String(CFG.BTN_SCALE);
      const valEl = $('#cx-scale-val');
      const setScale = (v) => {
        CFG.BTN_SCALE = v;
        panel.style.setProperty('--cx-btn-scale', String(v));
        if (valEl) valEl.textContent = Math.round(v * 100) + '%';
      };
      setScale(CFG.BTN_SCALE);
      scaleEl.oninput = () => {
        const v = parseFloat(scaleEl.value);
        if (!(v >= 0.75 && v <= 1.5)) return;
        setScale(v);
        savePrefs();
      };
    }

    const delayEl = $('#cx-ans-delay');
    if (delayEl) {
      delayEl.value = String(Math.round((CFG.ANSWER_DELAY || 0) / 1000));
      delayEl.onchange = () => {
        const v = parseFloat(delayEl.value);
        if (!(v >= 0) || v > 60) {
          delayEl.value = String(Math.round((CFG.ANSWER_DELAY || 0) / 1000));
          log('答题停顿要在 0~60 秒之间');
          return;
        }
        CFG.ANSWER_DELAY = Math.round(v * 1000);
        savePrefs();
        log('答题停顿设为 ' + v + ' 秒/题');
      };
    }

    $('#cx-bank').onclick = () => {
      const b = loadBank();
      let n = 0;
      $$('#cx-panel .ansinp').forEach((inp) => {
        const v = inp.value.trim();
        if (!v) return;
        const q = STATE.questions.find((x) => x.idx === +inp.dataset.idx);
        if (q) { b[fp(q)] = v; n++; }
      });
      saveBank(b);
      log(`存 ${n} 题，累计 ${Object.keys(b).length}`);
    };

    $('#cx-clear').onclick = () => {
      STATE.questions.forEach((q) => {
        if (q.kind === 'blank') q.editors.forEach((ed) => setEditor(ed, ''));
        else curAnswer(q).split('').forEach((ch) => clickOpt(q, ch));
      });
      STATE.autoAnswered.clear();   // 清空后允许重新自动答题
      lastAutoAt = 0;
      refreshWork();
      log('已清空');
    };

    paintState();
    renderLog();
    // 面板每次重建（切章节整页重载、脚本重新执行）后，把已保存的地址回填进去
    fillSettings();
  }

  // ==================== 启动 ====================
  (function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    buildPanel();
    log('已加载');

    // 页面切走再回来：恢复播放；如果已经停机就自动重启
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        // 切走时记一下，回来用于判断
        return;
      }

      setTimeout(() => {
        try {
          if (STATE.running) {
            log('页面恢复可见，检查播放状态');
            let n = 0;
            for (const j of videoJobs()) {
              const v = videoEl(j.frame);
              if (v && v.paused && !v.ended) {
                try { v.muted = true; v.play().catch(() => {}); n++; } catch (e) {}
              }
            }
            if (n) log(`已恢复播放 ${n} 个视频`);
            // 文档类任务点也重新拉起模拟阅读（阅读模式走慢速那套）
            if (!STATE.questions.length && !keepAliveTimer) {
              if (READ.enabled) startReadSession(); else startKeepReading();
            }
          } else if (STATE.reviveCount < 3) {
            const p = String(STATE.phase || '');
            const stalled = /超时|卡在|aborted|stuck|异常/.test(p);
            if (stalled && !STATE.userStopped) {
              STATE.reviveCount++;
              log(`页面恢复可见，检测到已停机（${p}），自动重启 ${STATE.reviveCount}/3`);
              setTimeout(() => runStudy(), 2500);
            }
          } else {
            log('页面恢复可见，但已自动重启 3 次，不再尝试');
          }
        } catch (e) {}
      }, 1200);
    });

    // 定时检查测验
    setInterval(() => {
      try {
        const before = STATE.questions.length;
        refreshWork();
        if (STATE.questions.length && !before) log(`检测到测验：${STATE.questions.length} 题`);
      } catch (e) {}
    }, 4000);

    setTimeout(() => refreshWork(), 1500);

    // 整页重载后自动续跑：上次是点「开始」跑起来的、且不是手动停止，
    // 重载把内存状态清空了，这里按持久化的运行意图重新拉起。
    if (getRunIntent() && !STATE.running && inWorkWindow()) {
      log('检测到上次在运行中被重载，5 秒后自动续跑');
      setTimeout(() => {
        if (getRunIntent() && !STATE.running && inWorkWindow()) runStudy();
      }, 5000);
    }
  })();
})();
