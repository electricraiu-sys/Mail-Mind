type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, any> | null;

/** Tiny hyperscript helper: el('div', {class: 'x', onclick: fn}, 'text', child) */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v; // only used with already-escaped markup
    else if (k in node && typeof v !== 'string') (node as any)[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

function append(node: Node, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(node, c);
    else if (c === null || c === undefined || c === false) continue;
    else node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const n = root.querySelector(sel);
  if (!n) throw new Error(`Missing element ${sel}`);
  return n as HTMLElement;
}

export function progressBar(): { node: HTMLElement; set(fraction?: number): void } {
  const bar = el('div');
  const node = el('div', { class: 'progress indeterminate' }, bar);
  return {
    node,
    set(fraction?: number) {
      if (fraction === undefined || !Number.isFinite(fraction)) {
        node.classList.add('indeterminate');
        bar.style.width = '';
      } else {
        node.classList.remove('indeterminate');
        bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      }
    },
  };
}

/** A button that needs a second click within a few seconds to confirm a destructive action. */
export function confirmButton(label: string, confirmLabel: () => string, onConfirm: () => void | Promise<void>, cls = 'danger'): HTMLButtonElement {
  let armed = false;
  let timer: number | undefined;
  const btn = el('button', { class: '' }, label);
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel();
      btn.className = cls;
      timer = window.setTimeout(() => {
        armed = false;
        btn.textContent = label;
        btn.className = '';
      }, 5000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    btn.textContent = label;
    btn.className = '';
    await onConfirm();
  });
  return btn;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

/** Saves a blob through the browser's download prompt. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
