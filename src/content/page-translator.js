// ── 整页原位翻译 ──────────────────────────────────────────
// 快捷键(Ctrl+Shift+X)触发：视口增量翻译，原位替换文本、不破坏排版；
// 再次触发在「译文/原文」间切换（译文有缓存，不重新请求）。
// 自包含普通脚本（content script 非 module），消息常量与 shared/constants.js 保持一致。
(function () {
  'use strict';

  const MSG_TOGGLE = 'PAGE_TRANSLATE_TOGGLE';
  const MSG_TRANSLATE = 'PAGE_TRANSLATE';

  // 整棵子树跳过的标签
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'TEXTAREA',
    'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS', 'IFRAME',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR', 'KBD', 'SAMP',
  ]);
  // 段落内按原子占位符处理（整体保留、内容不翻译）的行内标签
  const ATOMIC_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'BR', 'IMG', 'SVG', 'MATH', 'WBR', 'PICTURE']);
  // display:none 时无法取真实 display，按标签兜底判断行内
  const INLINE_FALLBACK = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'SMALL', 'SUP', 'SUB',
    'MARK', 'ABBR', 'TIME', 'CITE', 'Q', 'LABEL', 'FONT', 'BDI', 'BDO',
    'WBR', 'BR', 'IMG', 'CODE', 'KBD', 'SAMP', 'VAR', 'DATA', 'DFN', 'TT',
  ]);

  // 至少含一个文字字符（拉丁/西里尔/希腊/阿拉伯/泰文/假名/汉字/谚文等）才值得翻译
  const LETTER_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]/;

  const MAX_BATCH_ITEMS = 12;   // 单次请求最多块数
  const MAX_BATCH_CHARS = 2500; // 单次请求最多字符数（防止超出模型输出上限）
  const MAX_IN_FLIGHT = 2;      // 在途请求上限
  const FLUSH_DELAY = 400;      // 攒批节流（ms）

  let session = null;

  // ── 工具 ────────────────────────────────────────────────

  function isBlockish(el) {
    const d = getComputedStyle(el).display;
    if (d === 'none') return !INLINE_FALLBACK.has(el.tagName.toUpperCase());
    return !(d.startsWith('inline') || d === 'contents');
  }

  // 默认目标语言为中文：纯中文为主的块跳过，省 token（与划词翻译的默认约定一致）
  function isTranslatable(text) {
    const t = text.trim();
    if (t.length < 2 || !LETTER_RE.test(t)) return false;
    const cjk = (t.match(/[一-鿿]/g) || []).length;
    return cjk / t.length <= 0.5;
  }

  function toastOnce(message) {
    if (document.getElementById('ct-page-toast')) return;
    const div = document.createElement('div');
    div.id = 'ct-page-toast';
    div.textContent = `整页翻译：${message}`;
    div.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:rgba(30,30,30,.92);color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:13px/1.5 -apple-system,"Segoe UI",sans-serif;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
  }

  // ── 翻译会话 ────────────────────────────────────────────

  class PageTranslateSession {
    constructor() {
      this.active = true;        // 当前是否处于「译文」视图
      this.units = new Map();    // Element -> rec
      this.byId = new Map();     // id -> { rec, entry|null }
      this.queue = [];           // 待发送 [{ id, text }]
      this.inFlight = 0;
      this.flushTimer = null;
      this.idSeq = 0;
      this.io = new IntersectionObserver((entries) => this._onIntersect(entries), {
        rootMargin: '100% 0px 100% 0px', // 上下各预加载一屏
      });
      this.mo = new MutationObserver((muts) => this._onMutate(muts));
    }

    start() {
      this._collect(document.body);
      this.mo.observe(document.body, { childList: true, subtree: true });
    }

    // ── 扫描分块 ──

    _collect(el) {
      if (el.nodeType !== 1) return;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (this.units.has(el)) return;
      if (el.isContentEditable) return;

      let hasBlockChild = false;
      for (const child of el.children) {
        if (isBlockish(child)) { hasBlockChild = true; break; }
      }
      if (hasBlockChild) {
        // 容器：继续向下找翻译单元（容器内的零散文本不处理）
        for (const child of el.children) this._collect(child);
        return;
      }
      if (!isTranslatable(el.textContent)) return;

      const rec = {
        id: 'u' + this.idSeq++,
        el,
        mode: 'unit',            // 'unit' | 'nodes'（占位符校验失败后的逐文本节点降级）
        status: 'pending',       // 'pending' | 'queued' | 'done' | 'failed'
        inlineMap: null,         // 占位符序号 -> 原行内元素
        kinds: null,             // 占位符序号 -> 'wrap' | 'void'
        originalNodes: null,     // 原始子节点快照（首次回填时捕获）
        translatedNodes: null,   // 译文子节点缓存
        nodeEntries: null,       // 降级模式：[{ id, node, original, translated }]
      };
      this.units.set(el, rec);
      this.byId.set(rec.id, { rec, entry: null });
      this.io.observe(el);
    }

    _onMutate(muts) {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 跳过自身回填引起的变动
          if (node.closest && node.closest('[data-ct-state]')) continue;
          this._collect(node);
        }
      }
    }

    _onIntersect(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.io.unobserve(e.target);
        const rec = this.units.get(e.target);
        if (!rec || rec.status !== 'pending') continue;
        rec.status = 'queued';
        this._enqueueUnit(rec);
      }
      this._scheduleFlush();
    }

    // ── 序列化与入队 ──

    _enqueueUnit(rec) {
      const parts = [];
      const inlineMap = [];
      const kinds = [];
      for (const node of rec.el.childNodes) {
        if (node.nodeType === 3) {
          parts.push(node.nodeValue);
        } else if (node.nodeType === 1) {
          const n = inlineMap.length;
          const tag = node.tagName.toUpperCase();
          const txt = node.textContent;
          inlineMap.push(node);
          if (SKIP_TAGS.has(tag) || ATOMIC_TAGS.has(tag) || !LETTER_RE.test(txt)) {
            kinds.push('void');
            parts.push(`<x${n}/>`);
          } else {
            kinds.push('wrap');
            parts.push(`<x${n}>${txt}</x${n}>`);
          }
        }
      }
      rec.inlineMap = inlineMap;
      rec.kinds = kinds;
      this.queue.push({ id: rec.id, text: parts.join('') });
    }

    // ── 批量发送 ──

    _scheduleFlush(immediate) {
      if (!this.active || this.flushTimer || this.queue.length === 0) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this._flush();
      }, immediate ? 0 : FLUSH_DELAY);
    }

    _flush() {
      while (this.queue.length > 0 && this.inFlight < MAX_IN_FLIGHT && this.active) {
        const batch = [];
        let chars = 0;
        while (this.queue.length > 0 && batch.length < MAX_BATCH_ITEMS) {
          const item = this.queue[0];
          if (batch.length > 0 && chars + item.text.length > MAX_BATCH_CHARS) break;
          batch.push(this.queue.shift());
          chars += item.text.length;
        }
        this.inFlight++;
        chrome.runtime
          .sendMessage({ type: MSG_TRANSLATE, payload: { items: batch } })
          .then((resp) => this._onBatchResult(batch, resp))
          .catch((e) => this._onBatchResult(batch, { error: e.message }))
          .finally(() => {
            this.inFlight--;
            this._scheduleFlush(true);
          });
      }
    }

    _onBatchResult(batch, resp) {
      if (!resp || resp.error) {
        toastOnce(resp?.error || '请求失败');
        for (const item of batch) this._markFailed(item.id);
        return;
      }
      const results = new Map(resp.items.map((it) => [it.id, it.text]));
      for (const item of batch) {
        const target = this.byId.get(item.id);
        if (!target) continue;
        const translated = results.get(item.id);
        if (target.entry) {
          this._applyNodeEntry(target.rec, target.entry, translated);
        } else if (translated == null) {
          this._fallbackToNodes(target.rec); // 模型漏掉该块：降级重试
        } else {
          this._applyUnit(target.rec, translated);
        }
      }
      this._scheduleFlush(true);
    }

    _markFailed(id) {
      const target = this.byId.get(id);
      if (target && !target.entry) target.rec.status = 'failed';
    }

    // ── 回填（unit 模式）──

    _applyUnit(rec, translated) {
      const seq = this._parseMarked(translated, rec.inlineMap.length, rec.kinds);
      if (!seq) {
        this._fallbackToNodes(rec);
        return;
      }
      const nodes = [];
      for (const tok of seq) {
        if (tok.n === -1) {
          nodes.push(document.createTextNode(tok.text));
        } else if (tok.void) {
          nodes.push(rec.inlineMap[tok.n].cloneNode(true));
        } else {
          // 浅克隆保留属性（href/class 等），译文写入 textContent（行内嵌套样式被拍平，可接受）
          const clone = rec.inlineMap[tok.n].cloneNode(false);
          clone.textContent = tok.text;
          nodes.push(clone);
        }
      }
      if (!rec.originalNodes) rec.originalNodes = Array.from(rec.el.childNodes);
      rec.translatedNodes = nodes;
      rec.status = 'done';
      if (this.active) {
        rec.el.setAttribute('data-ct-state', 'translated');
        rec.el.replaceChildren(...nodes);
      }
    }

    // 解析译文中的占位符：标记必须不重不漏、配对正确，否则返回 null
    _parseMarked(out, count, kinds) {
      const tokens = out.split(/(<x\d+\s*\/>|<x\d+>|<\/x\d+>)/);
      const seq = [];
      const used = new Set();
      let cur = null;
      let buf = '';
      for (const t of tokens) {
        let m;
        if ((m = t.match(/^<x(\d+)\s*\/>$/))) {
          const n = +m[1];
          if (cur !== null || n >= count || kinds[n] !== 'void' || used.has(n)) return null;
          used.add(n);
          seq.push({ n, void: true });
        } else if ((m = t.match(/^<x(\d+)>$/))) {
          const n = +m[1];
          if (cur !== null || n >= count || kinds[n] !== 'wrap' || used.has(n)) return null;
          cur = n;
          buf = '';
        } else if ((m = t.match(/^<\/x(\d+)>$/))) {
          if (cur === null || +m[1] !== cur) return null;
          used.add(cur);
          seq.push({ n: cur, text: buf });
          cur = null;
        } else if (t) {
          if (cur !== null) buf += t;
          else seq.push({ n: -1, text: t });
        }
      }
      if (cur !== null || used.size !== count) return null;
      return seq;
    }

    // ── 降级：逐文本节点翻译（DOM 结构绝对安全）──

    _fallbackToNodes(rec) {
      if (rec.mode === 'nodes') {
        rec.status = 'failed'; // 已降级过，保持原文
        return;
      }
      rec.mode = 'nodes';
      rec.nodeEntries = [];
      const walker = document.createTreeWalker(rec.el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const p = node.parentElement;
          if (p) {
            const tag = p.tagName.toUpperCase();
            if (SKIP_TAGS.has(tag) || ATOMIC_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
          }
          return LETTER_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      let k = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const entry = { id: `${rec.id}:${k++}`, node, original: node.nodeValue, translated: null };
        rec.nodeEntries.push(entry);
        this.byId.set(entry.id, { rec, entry });
        this.queue.push({ id: entry.id, text: entry.original });
      }
      if (rec.nodeEntries.length === 0) {
        rec.status = 'failed';
        return;
      }
      this._scheduleFlush();
    }

    _applyNodeEntry(rec, entry, translated) {
      if (translated == null) return; // 模型漏掉：该节点保持原文
      entry.translated = translated;
      if (this.active) {
        rec.el.setAttribute('data-ct-state', 'translated');
        entry.node.nodeValue = translated;
      }
      if (rec.nodeEntries.every((e) => e.translated != null)) rec.status = 'done';
    }

    // ── 译文/原文 切换 ──

    showOriginal() {
      this.active = false;
      for (const rec of this.units.values()) {
        if (rec.el.getAttribute('data-ct-state') !== 'translated') continue;
        if (rec.mode === 'unit' && rec.originalNodes) {
          rec.el.replaceChildren(...rec.originalNodes);
        } else if (rec.mode === 'nodes' && rec.nodeEntries) {
          for (const e of rec.nodeEntries) {
            if (e.translated != null) e.node.nodeValue = e.original;
          }
        }
        rec.el.setAttribute('data-ct-state', 'original');
      }
    }

    showTranslation() {
      this.active = true;
      for (const rec of this.units.values()) {
        if (rec.mode === 'unit' && rec.translatedNodes) {
          rec.el.setAttribute('data-ct-state', 'translated');
          rec.el.replaceChildren(...rec.translatedNodes);
        } else if (rec.mode === 'nodes' && rec.nodeEntries) {
          let applied = false;
          for (const e of rec.nodeEntries) {
            if (e.translated != null) {
              e.node.nodeValue = e.translated;
              applied = true;
            }
          }
          if (applied) rec.el.setAttribute('data-ct-state', 'translated');
        }
      }
      this._scheduleFlush(true); // 继续翻译新进入视口的块
    }
  }

  // ── 消息入口 ────────────────────────────────────────────

  function toggle() {
    if (!session) {
      session = new PageTranslateSession();
      session.start();
    } else if (session.active) {
      session.showOriginal();
    } else {
      session.showTranslation();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === MSG_TOGGLE) toggle();
    return false;
  });

  // 暴露给同隔离环境的 index.js（侧边栏工具栏按钮），页面脚本不可见
  window.__ctPageTranslateToggle = toggle;
})();
