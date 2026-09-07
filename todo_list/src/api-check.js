// npm run api:check — 서버가 켜져 있을 때 API 를 실제로 호출해 R-ID 별로 확인한다.
//
// 왜 curl 대신 이 스크립트인가: Windows 의 Git Bash 에서 curl 에 한글을 -d 로 넘기면
// 인수가 CP949 로 변환되어 서버에 깨진 바이트가 도착한다(저장된 값이 U+FFFD 가 된다).
// 이 스크립트는 UTF-8 파일에서 읽은 문자열을 Node 의 fetch 로 보내므로 그 경로가 없다.
//
// 만든 항목은 끝에서 모두 지운다. 기존 데이터는 건드리지 않는다.

const BASE = `http://localhost:${process.env.PORT ?? 3000}`;
const MARK = '[점검]';

const pad = (n) => String(n).padStart(2, '0');
const dayOffset = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);
const TOMORROW = dayOffset(1);

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const results = [];
function check(rid, label, passed, detail = '') {
  results.push({ rid, label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${rid}  ${label}${detail ? `  — ${detail}` : ''}`);
}

// 이 스크립트가 만든 항목만 골라낸다.
const mine = (list) => list.filter((t) => t.title.startsWith(MARK));

try {
  await fetch(BASE + '/api/tags');
} catch {
  console.error(`서버에 연결할 수 없습니다 (${BASE}). 다른 터미널에서 npm start 를 먼저 실행하세요.`);
  process.exit(1);
}

// 기존 데이터가 있어도 결과가 달라지지 않도록, 시작 시점의 태그 연결 수를 먼저 재 둔다.
const tagCount = async (name) =>
  (await api('GET', '/api/tags')).data.find((t) => t.name === name)?.count ?? 0;
const urgentBefore = await tagCount('급함');

const created = [];
const add = async (body) => {
  const { data } = await api('POST', '/api/todos', { ...body, title: `${MARK} ${body.title}` });
  created.push(data.id);
  return data;
};

const milk = await add({ title: '우유 사기', due_date: TODAY, tags: ['장보기', '급함'] });
const bill = await add({ title: '전기요금 내기', due_date: YESTERDAY, tags: ['급함'] });
const book = await add({ title: '책 반납', due_date: TOMORROW, tags: ['  급함  ', '급함', ''] });
const room = await add({ title: '언젠가 방 정리', notes: '먼지 많음' });

// R-001 추가
check('R-001', '할 일을 추가하면 목록에 나타난다', mine((await api('GET', '/api/todos')).data).length === 4);

// 한글이 깨지지 않고 왕복하는가
check('----', '한글이 그대로 저장되고 돌아온다', milk.title === `${MARK} 우유 사기`, milk.title);

// R-006 태그 — 공백만 다른 태그와 빈 문자열은 걸러지고, 같은 태그는 재사용된다
check('R-006', '태그 여러 개가 붙는다', milk.tags.length === 2 && milk.tags.includes('급함'), milk.tags.join('/'));
check('R-006', '공백·중복·빈 태그가 정리된다', book.tags.length === 1 && book.tags[0] === '급함', JSON.stringify(book.tags));
{
  // 세 항목에 '급함' 을 붙였다. 태그 행은 하나만 있어야 하고 연결은 정확히 3개 늘어야 한다.
  const rows = (await api('GET', '/api/tags')).data.filter((t) => t.name === '급함');
  const after = await tagCount('급함');
  check('R-006', '같은 태그가 중복 생성되지 않는다', rows.length === 1, `태그 행 ${rows.length}개`);
  check('R-006', '태그 연결만 늘어난다', after === urgentBefore + 3, `연결 ${urgentBefore} -> ${after}`);
}
{
  const filtered = mine((await api('GET', '/api/todos?tag=장보기')).data);
  check('R-006', '태그로 걸러낸다', filtered.length === 1 && filtered[0].id === milk.id);
  check('R-006', '태그로 걸러도 나머지 태그가 남는다', filtered[0]?.tags.length === 2, JSON.stringify(filtered[0]?.tags));
}

// R-007 오늘
{
  const today = mine((await api('GET', `/api/todos?filter=today&today=${TODAY}`)).data);
  check('R-007', '오늘 마감만 나온다', today.length === 1 && today[0].id === milk.id, `${today.length}건`);
}

// R-008 검색
{
  const hit = mine((await api('GET', '/api/todos?q=우유')).data);
  check('R-008', '제목으로 검색된다', hit.length === 1 && hit[0].id === milk.id);
  const notes = mine((await api('GET', '/api/todos?q=먼지')).data);
  check('R-008', '메모도 검색된다', notes.length === 1 && notes[0].id === room.id);
  const wild = mine((await api('GET', '/api/todos?q=%25')).data);
  check('R-008', '% 를 쳐도 전체가 나오지 않는다', wild.length === 0, `${wild.length}건`);
  const under = mine((await api('GET', '/api/todos?q=_')).data);
  check('R-008', '_ 를 쳐도 전체가 나오지 않는다', under.length === 0, `${under.length}건`);
}

// 정렬 — 마감일 없는 항목이 맨 위로 올라오지 않아야 한다
{
  const list = mine((await api('GET', '/api/todos')).data);
  check('----', '마감일 없는 항목이 맨 뒤로 간다', list.at(-1)?.id === room.id, list.map((t) => t.due_date ?? 'null').join(' < '));
}

// R-002 완료 표시
{
  const patched = (await api('PATCH', `/api/todos/${bill.id}`, { done: true })).data;
  const again = (await api('GET', '/api/todos')).data.find((t) => t.id === bill.id);
  check('R-002', '완료 표시가 저장된다', patched.done === true && again.done === true);
}

// R-009 검증
{
  const empty = await api('POST', '/api/todos', { title: '   ' });
  check('R-009', '빈 제목은 400 으로 거부된다', empty.status === 400, empty.data?.error);
  const badDate = await api('POST', '/api/todos', { title: `${MARK} 형식`, due_date: '2026/09/07' });
  check('R-009', '잘못된 마감일 형식은 거부된다', badDate.status === 400, badDate.data?.error);
  const missing = await api('PATCH', '/api/todos/999999', { done: true });
  check('R-009', '없는 id 는 404 를 준다', missing.status === 404);
}

// R-003 삭제 + CASCADE
{
  const before = (await api('GET', '/api/tags')).data.find((t) => t.name === '급함').count;
  const del = await api('DELETE', `/api/todos/${book.id}`);
  created.splice(created.indexOf(book.id), 1);
  const after = (await api('GET', '/api/tags')).data.find((t) => t.name === '급함').count;
  const gone = (await api('GET', '/api/todos')).data.every((t) => t.id !== book.id);
  check('R-003', '삭제하면 목록에서 사라진다', del.status === 204 && gone);
  check('R-003', '연결 행도 CASCADE 로 함께 사라진다', after === before - 1, `${before} -> ${after}`);
}

// 정리
for (const id of created) await api('DELETE', `/api/todos/${id}`);
const leftover = mine((await api('GET', '/api/todos')).data);
check('----', '점검용 항목을 모두 정리했다', leftover.length === 0, `${leftover.length}건 남음`);

const failed = results.filter((r) => !r.passed);
console.log('');
console.log(`${results.length}개 검사 중 ${results.length - failed.length}개 통과`);
console.log(failed.length === 0 ? '=> 전체 통과' : `=> 실패: ${failed.map((f) => f.label).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
