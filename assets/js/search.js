// Search box as an ARIA combobox: type, move with the arrow keys, Enter picks.
// In list view the dropdown is off and typing filters the list instead.
import { esc } from './panel.js';

export class Search {
  constructor(input, listbox, { find, describe, onPick, onQuery }) {
    Object.assign(this, { input, listbox, find, describe, onPick, onQuery });
    this.items = [];
    this.active = -1;
    this.dropdown = true;

    input.addEventListener('input', () => this.update());
    input.addEventListener('focus', () => this.update());
    input.addEventListener('blur', () => this.close());
    input.addEventListener('keydown', e => this.onKey(e));
    // Keep focus in the input while clicking an option.
    listbox.addEventListener('pointerdown', e => e.preventDefault());
    listbox.addEventListener('click', e => {
      const option = e.target.closest('[data-id]');
      if (option) this.pick(option.dataset.id);
    });
  }

  setDropdown(enabled) {
    this.dropdown = enabled;
    if (!enabled) this.close();
  }

  update() {
    const query = this.input.value;
    this.onQuery(query);
    if (!this.dropdown || !query.trim()) {
      this.close();
      return;
    }
    this.items = this.find(query);
    this.active = this.items.length ? 0 : -1;
    this.render(query);
  }

  render(query) {
    this.listbox.innerHTML = this.items.length
      ? this.items.map((c, i) => `<li role="option" id="search-opt-${i}" data-id="${esc(c.id)}"
          aria-selected="${i === this.active}">${this.describe(c)}</li>`).join('')
      : `<li class="r-empty" role="option" aria-disabled="true">No courses match “${esc(query.trim())}”</li>`;
    this.listbox.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.syncActive();
  }

  syncActive() {
    this.listbox.querySelectorAll('[data-id]').forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    if (this.active >= 0) {
      this.input.setAttribute('aria-activedescendant', `search-opt-${this.active}`);
      this.listbox.children[this.active]?.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  close() {
    this.listbox.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  pick(id) {
    if (this.dropdown) {
      this.input.value = '';
      this.onQuery('');
      this.close();
      this.input.blur();
    }
    this.onPick(id);
  }

  onKey(e) {
    const open = !this.listbox.hidden && this.items.length > 0;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + this.items.length) % this.items.length;
      this.syncActive();
    } else if (e.key === 'Enter') {
      const target = open ? this.items[this.active] : !this.dropdown && this.find(this.input.value)[0];
      if (target) {
        e.preventDefault();
        this.pick(target.id);
      }
    } else if (e.key === 'Escape') {
      if (!this.listbox.hidden || this.input.value) {
        e.preventDefault();
        e.stopPropagation();
        if (this.listbox.hidden) {
          this.input.value = '';
          this.onQuery('');
        }
        this.close();
      } else {
        this.input.blur();
      }
    }
  }
}
