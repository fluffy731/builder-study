// Tiny DOM helpers. All data goes in as text nodes (never innerHTML), and
// null / undefined / false children are skipped, never rendered as the words
// "null" or "undefined".
//
//   el('p', { class: 'note' }, 'Hello ', cond && el('b', null, 'x'), maybeNull)
//   mount(root, ...children)   // replaces root's content
//
// attrs: null | { class, dataset:{}, style:'..'|{}, on<event>: fn, value/checked/
// disabled/readOnly/selected/hidden: property, other: attribute }.
// An attribute whose value is null / undefined / false is left off; true sets
// an empty attribute.

const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);
const UNSAFE_URL = /^(javascript|vbscript|data:text)/;

const PROPS = new Set(['value', 'checked', 'disabled', 'readOnly', 'selected', 'hidden', 'tabIndex']);

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  if (typeof child === 'string') {
    parent.appendChild(document.createTextNode(child));
  } else if (typeof child === 'number') {
    if (Number.isFinite(child)) parent.appendChild(document.createTextNode(String(child)));
  } else if (typeof child === 'object' && typeof child.nodeType === 'number') {
    parent.appendChild(child);
  } else {
    throw new TypeError(`dom: unsupported child of type ${typeof child}`);
  }
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'innerHTML' || key === 'outerHTML') throw new TypeError('dom: innerHTML is not allowed');
      if (key === 'class' || key === 'className') node.className = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.toLowerCase().startsWith('on')) {
        // Only real functions; a string would become an inline handler attribute.
        if (typeof value !== 'function') throw new TypeError(`dom: ${key} must be a function`);
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key.toLowerCase() === 'srcdoc') throw new TypeError('dom: srcdoc is not allowed');
      else if (URL_ATTRS.has(key.toLowerCase()) && UNSAFE_URL.test(String(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase())) {
        throw new TypeError(`dom: unsafe URL in ${key}`);
      } else if (PROPS.has(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

export function mount(root, ...children) {
  const holder = document.createDocumentFragment();
  for (const c of children) appendChild(holder, c);
  root.replaceChildren(holder);
  return root;
}
