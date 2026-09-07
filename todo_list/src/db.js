// DB 열기와 모든 SQL. 서버(server.js)는 여기 있는 함수만 호출하고 SQL 을 직접 쓰지 않는다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 실행한 폴더가 아니라 프로젝트 폴더를 기준으로 경로를 잡는다.
// 이렇게 하지 않으면 어디서 npm start 했느냐에 따라 다른 todo.db 가 만들어진다.
const projectRoot = path.resolve(import.meta.dirname, '..');
export const dbPath = path.resolve(projectRoot, process.env.DB_PATH ?? 'todo.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(path.join(projectRoot, 'schema.sql'), 'utf8'));

// group_concat 구분자로 쉼표 대신 US(0x1f) 문자를 쓴다. 태그 이름에 쉼표가 들어가도 안 깨진다.
// 눈에 안 보이는 문자를 소스에 직접 넣으면 편집기가 지울 수 있으므로 코드로 만든다.
// SQL 쪽 char(31) 과 반드시 같은 값이어야 한다.
const SEP = String.fromCharCode(31);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function shape(row) {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes ?? null,
    done: Number(row.is_done) === 1,
    due_date: row.due_date ?? null,
    created_at: row.created_at,
    tags: row.tag_names ? String(row.tag_names).split(SEP) : [],
  };
}

// 검색어의 % 와 _ 는 LIKE 의 와일드카드다. 이스케이프하지 않으면
// 검색창에 % 한 글자만 쳐도 전체 목록이 나온다.
function likePattern(text) {
  return '%' + String(text).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
}

export function normalizeTags(input) {
  const items = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const name = String(item).trim().replace(/\s+/g, ' ');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

// 없는 태그는 만들고 있는 태그는 재사용한다.
function tagIdFor(name) {
  db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
  return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
}

function setTags(todoId, names) {
  db.prepare('DELETE FROM todo_tags WHERE todo_id = ?').run(todoId);
  const link = db.prepare('INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)');
  for (const name of names) link.run(todoId, tagIdFor(name));
}

const SELECT_TODOS = `
  SELECT t.id, t.title, t.notes, t.is_done, t.due_date, t.created_at,
         group_concat(g.name, char(31)) AS tag_names
  FROM todos t
  LEFT JOIN todo_tags tt ON tt.todo_id = t.id
  LEFT JOIN tags g       ON g.id = tt.tag_id
`;

// 미완료 먼저, 마감일 가까운 순. `due_date IS NULL` 을 빼면 SQLite 가 NULL 을
// 먼저 정렬해서 마감일 없는 항목이 목록 맨 위로 올라온다.
const ORDER_TODOS = `
  GROUP BY t.id
  ORDER BY t.is_done, t.due_date IS NULL, t.due_date, t.created_at
`;

export function listTodos({ filter = 'all', q = '', tag = '', today = '' } = {}) {
  const where = [];
  const params = [];

  if (filter === 'open') {
    where.push('t.is_done = 0');
  } else if (filter === 'today') {
    where.push('t.is_done = 0 AND t.due_date = ?');
    params.push(today);
  } else if (filter === 'done') {
    where.push('t.is_done = 1');
  }

  if (q) {
    where.push(`(t.title LIKE ? ESCAPE '\\' OR COALESCE(t.notes, '') LIKE ? ESCAPE '\\')`);
    params.push(likePattern(q), likePattern(q));
  }

  // 태그 필터를 JOIN 조건에 넣으면 그 항목의 나머지 태그가 결과에서 사라진다.
  // EXISTS 로 걸러야 "이 태그를 가진 할 일"을 고르면서 태그 목록은 온전히 남는다.
  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM todo_tags x JOIN tags y ON y.id = x.tag_id
      WHERE x.todo_id = t.id AND y.name = ?
    )`);
    params.push(tag);
  }

  const sql = SELECT_TODOS + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ORDER_TODOS;
  return db.prepare(sql).all(...params).map(shape);
}

export function getTodo(id) {
  const sql = SELECT_TODOS + ' WHERE t.id = ?' + ORDER_TODOS;
  const row = db.prepare(sql).get(id);
  return row ? shape(row) : null;
}

export function createTodo({ title, notes = null, due_date = null, tags = [] }) {
  return tx(() => {
    const info = db
      .prepare('INSERT INTO todos (title, notes, due_date) VALUES (?, ?, ?)')
      .run(title, notes, due_date);
    const id = Number(info.lastInsertRowid);
    setTags(id, tags);
    return getTodo(id);
  });
}

export function updateTodo(id, patch) {
  return tx(() => {
    const sets = [];
    const params = [];
    // 열 이름은 코드에 적힌 목록에서만 나온다. 요청 본문의 키가 SQL 로 흘러들지 않는다.
    if ('title' in patch) { sets.push('title = ?'); params.push(patch.title); }
    if ('notes' in patch) { sets.push('notes = ?'); params.push(patch.notes); }
    if ('due_date' in patch) { sets.push('due_date = ?'); params.push(patch.due_date); }
    if ('done' in patch) { sets.push('is_done = ?'); params.push(patch.done ? 1 : 0); }

    if (sets.length) {
      const info = db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      if (info.changes === 0) return null;
    } else if (!getTodo(id)) {
      return null;
    }

    if ('tags' in patch) setTags(id, patch.tags);
    return getTodo(id);
  });
}

export function deleteTodo(id) {
  // todo_tags 의 연결 행은 ON DELETE CASCADE 로 함께 사라진다.
  return db.prepare('DELETE FROM todos WHERE id = ?').run(id).changes > 0;
}

export function listTags() {
  return db
    .prepare(`
      SELECT g.id, g.name, COUNT(tt.todo_id) AS count
      FROM tags g
      LEFT JOIN todo_tags tt ON tt.tag_id = g.id
      GROUP BY g.id
      ORDER BY g.name
    `)
    .all()
    .map((row) => ({ id: Number(row.id), name: row.name, count: Number(row.count) }));
}

export function inspect() {
  const rows = (sql) => db.prepare(sql).all();
  return {
    dbPath,
    foreign_keys: Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys),
    tables: rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name),
    indexes: rows("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name),
    triggers: rows("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").map((r) => r.name),
    counts: {
      todos: Number(db.prepare('SELECT COUNT(*) AS c FROM todos').get().c),
      tags: Number(db.prepare('SELECT COUNT(*) AS c FROM tags').get().c),
      todo_tags: Number(db.prepare('SELECT COUNT(*) AS c FROM todo_tags').get().c),
    },
  };
}
