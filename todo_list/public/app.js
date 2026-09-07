// 화면. 서버 API 만 호출하고, 목록은 매번 서버에서 받은 것으로 다시 그린다.

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const statusEl = $('status');
const tagBarEl = $('tag-bar');
const errorEl = $('form-error');

// 화면 상태. 필터·검색어·태그는 서버 쿼리로 그대로 넘어간다.
const state = { filter: 'all', q: '', tag: '' };

// 오늘 날짜는 브라우저의 로컬 시각으로 만든다.
// SQL 에서 date('now') 를 쓰면 UTC 라서 한국 시간 오전 9시 전에는 어제 날짜가 나온다.
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `요청이 실패했습니다 (${res.status})`);
  return data;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function dueLabel(dueDate, done) {
  const today = todayLocal();
  const el = document.createElement('span');
  el.className = 'due';
  if (dueDate < today && !done) {
    el.classList.add('overdue');
    el.textContent = `${dueDate} 지남`;
  } else if (dueDate === today) {
    el.textContent = '오늘';
  } else {
    el.textContent = dueDate;
  }
  return el;
}

// 제목·메모·태그는 사용자가 입력한 문자열이다. innerHTML 로 넣지 않고
// textContent 로만 넣어 <script> 같은 입력이 태그로 해석될 여지를 없앤다.
function itemNode(todo) {
  const li = document.createElement('li');
  li.className = 'item' + (todo.done ? ' done' : '');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = todo.done;
  box.setAttribute('aria-label', `${todo.title} 완료 표시`);
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api('PATCH', `/api/todos/${todo.id}`, { done: box.checked });
      await refresh();
    } catch (error) {
      showError(error.message);
      box.checked = !box.checked;
    } finally {
      box.disabled = false;
    }
  });

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = todo.title;
  body.append(title);

  if (todo.notes) {
    const notes = document.createElement('div');
    notes.className = 'notes';
    notes.textContent = todo.notes;
    body.append(notes);
  }

  if (todo.due_date || todo.tags.length) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (todo.due_date) meta.append(dueLabel(todo.due_date, todo.done));
    for (const name of todo.tags) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag';
      tag.textContent = `#${name}`;
      tag.title = `'${name}' 태그로 걸러 보기`;
      tag.addEventListener('click', () => {
        state.tag = state.tag === name ? '' : name;
        refresh();
      });
      meta.append(tag);
    }
    body.append(meta);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.textContent = '삭제';
  del.setAttribute('aria-label', `${todo.title} 삭제`);
  del.addEventListener('click', async () => {
    if (!confirm(`'${todo.title}'을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api('DELETE', `/api/todos/${todo.id}`);
      await refresh();
    } catch (error) {
      showError(error.message);
    }
  });

  li.append(box, body, del);
  return li;
}

function renderTagBar(tags) {
  tagBarEl.replaceChildren();
  const used = tags.filter((t) => t.count > 0);
  if (used.length === 0) return;

  for (const tag of used) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (state.tag === tag.name ? ' on' : '');
    chip.textContent = `#${tag.name} ${tag.count}`;
    chip.addEventListener('click', () => {
      state.tag = state.tag === tag.name ? '' : tag.name;
      refresh();
    });
    tagBarEl.append(chip);
  }
}

function describe(count) {
  const parts = [];
  if (state.filter === 'today') parts.push('오늘 마감');
  else if (state.filter === 'open') parts.push('미완료');
  else if (state.filter === 'done') parts.push('완료');
  if (state.tag) parts.push(`#${state.tag}`);
  if (state.q) parts.push(`'${state.q}' 검색`);
  const prefix = parts.length ? parts.join(' · ') + ' — ' : '';
  return `${prefix}${count}건`;
}

async function refresh() {
  const params = new URLSearchParams({ filter: state.filter });
  if (state.q) params.set('q', state.q);
  if (state.tag) params.set('tag', state.tag);
  if (state.filter === 'today') params.set('today', todayLocal());

  try {
    const [todos, tags] = await Promise.all([
      api('GET', `/api/todos?${params}`),
      api('GET', '/api/tags'),
    ]);

    showError('');
    statusEl.textContent = describe(todos.length);
    renderTagBar(tags);

    listEl.replaceChildren();
    if (todos.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '표시할 할 일이 없습니다.';
      listEl.append(empty);
    } else {
      for (const todo of todos) listEl.append(itemNode(todo));
    }

    for (const chip of document.querySelectorAll('[data-filter]')) {
      chip.classList.toggle('on', chip.dataset.filter === state.filter);
    }
  } catch (error) {
    showError(error.message);
  }
}

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('title').value.trim();
  if (!title) {
    showError('제목을 입력하세요.');
    $('title').focus();
    return;
  }

  try {
    await api('POST', '/api/todos', {
      title,
      due_date: $('due').value || null,
      tags: $('tags').value,
    });
    $('title').value = '';
    $('due').value = '';
    $('tags').value = '';
    $('title').focus();
    await refresh();
  } catch (error) {
    showError(error.message);
  }
});

$('title').addEventListener('input', () => showError(''));

for (const chip of document.querySelectorAll('[data-filter]')) {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    refresh();
  });
}

let searchTimer;
$('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => {
    state.q = value.trim();
    refresh();
  }, 200);
});

refresh();
