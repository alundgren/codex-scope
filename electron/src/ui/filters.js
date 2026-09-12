export function attachFilters({ getGeneration, changed, error }) {
  const search = document.querySelector('#search');
  const session = document.querySelector('#session');
  const hooks = document.querySelector('#hooks');
  const menu = document.querySelector('#hookmenu');
  const selectedHooks = new Set();
  let selectedSession = null;
  const pages = { session: { values: [] }, hook: { values: [] } };
  const pending = new Map();
  let loading = false;
  const value = () => ({ text: search.value, session: selectedSession, hooks: [...selectedHooks] });
  function notify(delay = 0) { changed(value(), delay); }
  function option(text, value) {
    const node = document.createElement('option');
    node.textContent = text; node.value = value;
    return node;
  }
  function button(text, action) {
    const node = document.createElement('button');
    node.textContent = text;
    node.addEventListener('click', action);
    return node;
  }
  function draw(field) {
    const page = pages[field];
    if (field === 'session') {
      session.replaceChildren(option('All sessions', ''));
      const values = selectedSession !== null && !page.values.includes(selectedSession) ? [selectedSession, ...page.values] : page.values;
      for (const name of values) session.append(option(name || 'Empty session ID', JSON.stringify(name)));
      if (page.previous) session.append(option('Previous sessions…', '@previous'));
      if (page.next) session.append(option('More sessions…', '@next'));
      session.value = selectedSession === null ? '' : JSON.stringify(selectedSession);
    } else {
      document.querySelector('#hook-label').textContent = selectedHooks.size ? `${selectedHooks.size} hook ${selectedHooks.size === 1 ? 'type' : 'types'}` : 'All hooks';
      menu.replaceChildren();
      if (selectedHooks.size) menu.append(button('All hooks', () => { selectedHooks.clear(); draw('hook'); notify(); }));
      const values = [...new Set([...selectedHooks, ...page.values])];
      for (const name of values) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = selectedHooks.has(name);
        input.addEventListener('change', () => {
          if (input.checked) selectedHooks.add(name); else selectedHooks.delete(name);
          if (selectedHooks.size > 32 || new TextEncoder().encode(JSON.stringify(value())).length > 128 * 1024) {
            selectedHooks.delete(name); input.checked = false;
            error('Choose fewer hook types before adding another.');
            return;
          }
          document.querySelector('#hook-label').textContent = selectedHooks.size ? `${selectedHooks.size} hook ${selectedHooks.size === 1 ? 'type' : 'types'}` : 'All hooks';
          notify();
        });
        label.append(input, document.createTextNode(name || 'Empty hook type'));
        menu.append(label);
      }
      if (page.previous) menu.append(button('Previous hooks', () => load(field, page.values[0], 'previous')));
      if (page.next) menu.append(button('More hooks', () => load(field, page.values.at(-1), 'next')));
    }
  }
  async function load(field, cursor = null, direction = 'next') {
    pending.set(field, { generation: getGeneration(), cursor, direction });
    if (loading) return;
    loading = true;
    try {
      while (pending.size) {
        const [field, request] = pending.entries().next().value;
        pending.delete(field);
        const result = await window.scope.choices(request.generation, field, request.cursor, request.direction);
        if (request.generation !== getGeneration() || result.stale || pending.has(field)) continue;
        if (result.error) { error(result.error); continue; }
        pages[field] = result;
        draw(field);
      }
    } catch { error('Filter choices could not be loaded. Open the filter to try again.'); }
    finally { loading = false; }
  }
  search.addEventListener('input', () => notify(180));
  session.addEventListener('change', () => {
    if (session.value.startsWith('@')) {
      const direction = session.value.slice(1);
      load('session', direction === 'previous' ? pages.session.values[0] : pages.session.values.at(-1), direction);
      session.value = selectedSession === null ? '' : JSON.stringify(selectedSession);
      return;
    }
    const previous = selectedSession;
    selectedSession = session.value === '' ? null : JSON.parse(session.value);
    if (new TextEncoder().encode(JSON.stringify(value())).length > 128 * 1024) {
      selectedSession = previous; draw('session'); error('Clear some hook choices before selecting this session.'); return;
    }
    notify();
  });
  session.addEventListener('focus', () => load('session'));
  hooks.addEventListener('toggle', () => { if (hooks.open) load('hook'); });
  function refresh() { load('session'); load('hook'); }
  function reset() {
    search.value = ''; selectedSession = null; selectedHooks.clear();
    draw('session'); draw('hook'); notify();
  }
  return { value, refresh, reset };
}
