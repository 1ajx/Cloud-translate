const CSS_URL = chrome.runtime.getURL('src/content/content.css');

export class FloatingPanel {
  constructor() {
    this._host = null;
    this._shadow = null;
    this._contentEl = null;
    this._footerEl = null;
    this._text = '';
    this._rafPending = false;
    this._pendingChunks = [];
  }

  /** 创建并显示浮窗（loading 状态） */
  show(position) {
    this.destroy();

    this._host = document.createElement('div');
    this._shadow = this._host.attachShadow({ mode: 'open' });

    // 注入样式
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    this._shadow.appendChild(link);

    // 构建 DOM
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.left = `${this._clampX(position.x)}px`;
    panel.style.top = `${this._clampY(position.y)}px`;

    const header = document.createElement('div');
    header.className = 'panel-header';

    const label = document.createElement('span');
    label.className = 'panel-label';
    label.textContent = '翻译结果';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.destroy());

    header.appendChild(label);
    header.appendChild(closeBtn);

    this._contentEl = document.createElement('div');
    this._contentEl.className = 'panel-content loading';
    this._contentEl.textContent = '翻译中…';

    this._footerEl = document.createElement('div');
    this._footerEl.className = 'panel-footer';
    this._footerEl.style.display = 'none';

    panel.appendChild(header);
    panel.appendChild(this._contentEl);
    panel.appendChild(this._footerEl);
    this._shadow.appendChild(panel);

    document.body.appendChild(this._host);
    this._makeDraggable(header, panel);
  }

  /** 追加流式译文片段 */
  appendChunk(chunk) {
    if (!this._contentEl) return;

    if (this._text === '') {
      // 首个 chunk：清除 loading 状态
      this._contentEl.classList.remove('loading');
      this._contentEl.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this._contentEl.appendChild(cursor);
    }

    this._pendingChunks.push(chunk);
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => this._flushChunks());
    }
  }

  _flushChunks() {
    this._rafPending = false;
    if (!this._contentEl) return;

    const cursor = this._contentEl.querySelector('.cursor');
    for (const chunk of this._pendingChunks) {
      this._text += chunk;
      const textNode = document.createTextNode(chunk);
      this._contentEl.insertBefore(textNode, cursor);
    }
    this._pendingChunks = [];
  }

  /** 翻译完成 */
  done() {
    if (!this._contentEl) return;
    this._flushChunks();

    const cursor = this._contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();

    // 显示复制按钮
    this._footerEl.style.display = 'flex';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this._text).then(() => {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => (copyBtn.textContent = '复制'), 1500);
      });
    });
    this._footerEl.appendChild(copyBtn);
  }

  /** 显示错误 */
  showError(message) {
    if (!this._contentEl) return;
    const cursor = this._contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    this._contentEl.classList.remove('loading');
    this._contentEl.innerHTML = '';
    const err = document.createElement('span');
    err.className = 'error-text';
    err.textContent = `⚠ ${message}`;
    this._contentEl.appendChild(err);
  }

  /** 销毁浮窗 */
  destroy() {
    if (this._host) {
      this._host.remove();
      this._host = null;
      this._shadow = null;
      this._contentEl = null;
      this._footerEl = null;
      this._text = '';
      this._pendingChunks = [];
      this._rafPending = false;
    }
  }

  /** 拖拽支持 */
  _makeDraggable(handle, panel) {
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(panel.style.left) || 0;
      startTop = parseInt(panel.style.top) || 0;

      const onMove = (e) => {
        panel.style.left = `${startLeft + e.clientX - startX}px`;
        panel.style.top = `${startTop + e.clientY - startY}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _clampX(x) {
    return Math.min(Math.max(x, 8), window.innerWidth - 380);
  }

  _clampY(y) {
    return Math.min(Math.max(y, 8), window.innerHeight - 200);
  }
}
