import { h, clear } from '../ui.js';
export function renderPlaceholder(root, title) {
  clear(root).append(h('section', { class: 'panel' }, h('h1', {}, title), h('p', { class: 'muted' }, 'この画面は、このあと作ります。')));
}
