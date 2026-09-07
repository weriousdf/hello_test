// npm run db:check — DB 가 설계대로 만들어졌는지 눈으로 확인하는 스크립트.
import { existsSync, statSync } from 'node:fs';
import { inspect } from './db.js';

const info = inspect();
const ok = (v) => (v ? '통과' : '실패');

console.log('DB 파일   :', info.dbPath);
console.log('파일 존재 :', existsSync(info.dbPath) ? `예 (${statSync(info.dbPath).size} bytes)` : '아니오');
console.log('외래키    :', info.foreign_keys, info.foreign_keys === 1 ? '(ON — 정상)' : '(OFF — CASCADE 가 동작하지 않는다)');
console.log('표        :', info.tables.join(', '));
console.log('인덱스    :', info.indexes.join(', '));
console.log('트리거    :', info.triggers.join(', '));
console.log('행 개수   : todos', info.counts.todos, '/ tags', info.counts.tags, '/ todo_tags', info.counts.todo_tags);

const wantTables = ['tags', 'todo_tags', 'todos'];
const wantIndexes = ['idx_todo_tags_tag', 'idx_todos_open_due'];
const missingTables = wantTables.filter((n) => !info.tables.includes(n));
const missingIndexes = wantIndexes.filter((n) => !info.indexes.includes(n));

console.log('');
console.log('표 3개        :', ok(missingTables.length === 0), missingTables.length ? `(없음: ${missingTables})` : '');
console.log('인덱스 2개    :', ok(missingIndexes.length === 0), missingIndexes.length ? `(없음: ${missingIndexes})` : '');
console.log('외래키 ON     :', ok(info.foreign_keys === 1));

const allOk = !missingTables.length && !missingIndexes.length && info.foreign_keys === 1;
console.log('');
console.log(allOk ? '=> 전체 통과' : '=> 실패');
process.exit(allOk ? 0 : 1);
