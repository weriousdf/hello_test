// Express 앱. SQL 은 여기 없다 — 전부 db.js 의 함수를 호출한다.
import express from 'express';
import path from 'node:path';
import {
  dbPath, listTodos, getTodo, createTodo, updateTodo, deleteTodo, listTags, normalizeTags,
} from './db.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const publicDir = path.resolve(import.meta.dirname, '..', 'public');

app.use(express.json());
app.use(express.static(publicDir));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 요청 본문에서 쓸 값만 골라내고 형식을 검사한다. 통과하지 못한 요청은 DB 까지 가지 않는다.
function readTodoInput(body, { partial = false } = {}) {
  const out = {};

  if (!partial || 'title' in body) {
    const title = String(body.title ?? '').trim();
    if (!title) return { error: '제목을 입력하세요.' };
    out.title = title;
  }

  if ('notes' in body) {
    const notes = String(body.notes ?? '').trim();
    out.notes = notes || null;
  }

  if ('due_date' in body) {
    const due = body.due_date;
    if (due === null || due === '') {
      out.due_date = null;
    } else if (DATE_RE.test(String(due))) {
      out.due_date = String(due);
    } else {
      return { error: '마감일은 YYYY-MM-DD 형식이어야 합니다.' };
    }
  }

  if ('done' in body) out.done = Boolean(body.done);
  if ('tags' in body) out.tags = normalizeTags(body.tags);

  return { value: out };
}

function readId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.get('/api/todos', (req, res) => {
  const { filter = 'all', q = '', tag = '', today = '' } = req.query;
  if (filter === 'today' && !DATE_RE.test(String(today))) {
    return res.status(400).json({ error: '오늘 필터에는 today=YYYY-MM-DD 가 필요합니다.' });
  }
  res.json(listTodos({ filter: String(filter), q: String(q), tag: String(tag), today: String(today) }));
});

app.post('/api/todos', (req, res) => {
  const { value, error } = readTodoInput(req.body ?? {});
  if (error) return res.status(400).json({ error });
  res.status(201).json(createTodo({ tags: [], ...value }));
});

app.patch('/api/todos/:id', (req, res) => {
  const id = readId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id 가 올바르지 않습니다.' });

  const { value, error } = readTodoInput(req.body ?? {}, { partial: true });
  if (error) return res.status(400).json({ error });
  if (Object.keys(value).length === 0) return res.status(400).json({ error: '바꿀 내용이 없습니다.' });

  const todo = updateTodo(id, value);
  if (!todo) return res.status(404).json({ error: '해당 할 일이 없습니다.' });
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  const id = readId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id 가 올바르지 않습니다.' });
  if (!deleteTodo(id)) return res.status(404).json({ error: '해당 할 일이 없습니다.' });
  res.status(204).end();
});

app.get('/api/tags', (_req, res) => res.json(listTags()));

// 예상 못 한 오류가 나도 스택 추적을 브라우저로 흘려보내지 않는다.
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: '서버에서 오류가 났습니다. 터미널 로그를 확인하세요.' });
});

app.listen(PORT, () => {
  console.log(`Todo 앱 실행 중 -> http://localhost:${PORT}`);
  console.log(`데이터 저장 위치 -> ${dbPath}`);
});
