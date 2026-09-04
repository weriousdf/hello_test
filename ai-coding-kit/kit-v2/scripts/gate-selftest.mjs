#!/usr/bin/env node
// gate-selftest — 게이트의 각 검사가 실제로 실패를 낼 수 있는지 판정한다.
//
// 왜 이 파일이 있는가.
//   v1 미션에서 8개 검사 중 2개가 죽은 채로 PASS 를 내고 있었다. 검사 7 은 처음부터
//   죽은 채 출하됐고(날짜 기준이라 같은 날 안에서는 판정 불가), 검사 6 은 탐색 경로에
//   PROGRESS.md 가 들어 있어 계획에 R-ID 를 적는 순간 통과했다. 둘 다 사람이 우연히
//   스크립트를 읽어보고서야 발견했다. 게이트가 스스로 신고하지 않았다.
//
//   회귀 항목에는 mutation: 칸이 있다 — "이 항목이 실패를 잡는 것을 본 적이 있는가".
//   그 원리를 게이트 검사 자신에게 적용한 것이 이 파일이다.
//
// 언제 도는가.
//   gate.mjs 가 바뀔 때만. 단계마다 돌지 않는다. 단계당 비용은 0 이다.
//
// 판정 규칙.
//   각 검사는 두 가지를 통과해야 자격이 있다.
//     (1) 위반 상태를 만들면 그 검사가 FAIL 을 낸다        — 민감도
//     (2) 정상 상태에서는 FAIL 을 내지 않는다              — 특이도
//   (1) 을 못 하는 검사는 장식이다. 고치거나 뺀다.
//   (2) 를 못 하는 검사는 거짓 경보기다. 사람이 게이트를 무시하게 만든다.
//
// 픽스처를 쓸 때 지킬 규칙 두 개. 둘 다 v1 에서 실패한 자리에서 나왔다.
//
//   규칙 1 — 픽스처는 실제 작업 상태를 재현한다. 최소 상태를 만들지 않는다.
//     v1 RUNBOOK §1.4 에 이미 수동 의례가 있었다: SPEC.md 에 R-099 를 한 줄 넣고
//     검사 6 이 FAIL 을 내는지 눈으로 본다. 그런데 그 의례는 PROGRESS.md 가 없는
//     상태에서 시험했고, 검사 6 의 버그는 R-ID 가 PROGRESS.md 에 적혀 있을 때만
//     드러났다. 실측으로 확인했다 — 버그 있는 게이트에 R-099 만 넣으면 FAIL(정상처럼
//     보임), R-099 를 PROGRESS.md 에도 적으면 PASS(버그 발현). 의례를 지켜도 버그를
//     못 본다. 픽스처에서 무언가를 빼면 그것 때문에 생기는 버그를 볼 수 없다.
//
//   규칙 2 — 원장에는 항목을 여러 개 두고, 위반은 첫 항목이 아닌 것에 건다.
//     항목이 하나면 items[0] 만 보고 루프를 돌지 않는 게이트도 통과한다.
//
// 게이트와의 계약.
//   gate.mjs 는 검사마다 아래 형식의 한 줄을 stdout 에 낸다.
//     CHECK <id> <PASS|FAIL|SKIP>
//   그리고 종료 코드는 0=PASS 1=FAIL 2=실행불가 3=PARTIAL 이다.
//   이 selftest 는 gate.mjs 를 자식 프로세스로 실행한다. 내부 함수를 부르지 않는다.
//   실제로 사람이 돌리는 그 명령을 그대로 돌려야 계약을 검증할 수 있다.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, 'gate.mjs');

// ─────────────────────────────────────────────────────────────────────────────
// 픽스처 — 최소한의 정상 프로젝트 하나를 만들고, 거기서 한 군데만 어긋뜨린다.
// 한 번에 한 군데만 어긋뜨리는 것이 중요하다. 두 군데면 어느 검사가 잡았는지 모른다.
// ─────────────────────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

// 정상 프로젝트. 요구 2개(R-001, R-002), 각각을 검증하는 테스트와 회귀 항목,
// 열린 blocker 0개, 수동 체크표 빈칸 0개. 커밋까지 끝난 상태.
// 요구와 항목을 2개씩 두는 것은 규칙 2 때문이다 — 위반을 두 번째에 걸어야
// items[0] 만 보는 게이트를 잡을 수 있다.
function makeCleanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-selftest-'));

  write(root, '.gitignore', 'node_modules/\nruns/\n');
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }, null, 2) + '\n');

  write(root, 'src/add.js', [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'module.exports = { add };',
    '',
  ].join('\n'));

  // 규칙 2 — 의존 파일을 둘로 나눠 둔다. 그래야 위반을 두 번째 항목에만 걸 수 있다.
  write(root, 'src/mul.js', [
    'function mul(a, b) {',
    '  return a * b;',
    '}',
    '',
    'module.exports = { mul };',
    '',
  ].join('\n'));

  write(root, 'src/add.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const { add } = require('./add.js');",
    "const { mul } = require('./mul.js');",
    '',
    "test('R-001 add sums two numbers', () => {",
    '  assert.strictEqual(add(2, 3), 5);',
    '});',
    '',
    "test('R-002 mul multiplies two numbers', () => {",
    '  assert.strictEqual(mul(2, 3), 6);',
    '});',
    '',
  ].join('\n'));

  write(root, 'SPEC.md', [
    '# SPEC',
    '',
    '## 기능 표',
    '',
    '| R-ID | 동작 문장 | 검증 기준 |',
    '|---|---|---|',
    '| R-001 | add(a,b) 는 두 수의 합을 돌려준다 | add(2,3) 이 정확히 5 다 |',
    '| R-002 | mul(a,b) 는 두 수의 곱을 돌려준다 | mul(2,3) 이 정확히 6 다 |',
    '',
  ].join('\n'));

  write(root, 'ISSUES.md', [
    '# ISSUES',
    '',
    '형식:',
    '',
    '```',
    '- [ ] ISS-<번호> | blocker|major|minor | <R-ID> | 처리:<N단계> | <증거> | <재현 명령>',
    '```',
    '',
    '## 원장',
    '',
    '- [x] ISS-001 | blocker | R-001 | 처리:1단계 | 예시로 이미 닫힌 항목 | node --test',
    '',
  ].join('\n'));

  // 규칙 2 — 채워진 줄을 먼저 두고, 위반은 그 다음 줄에 만든다.
  write(root, 'CHECKS.md', [
    '# CHECKS — 기계가 잴 수 없어 사람이 눈으로 판정하는 것만',
    '',
    '| 항목 | 무엇을 하면 무엇이 보이는가 | 결과 |',
    '|---|---|---|',
    '| R-001 표시 | 합이 굵게 보인다 | PASS 2026-09-05 |',
    '',
  ].join('\n'));

  // 규칙 1 — 실제 프로젝트에는 게이트 파일이 저장소 **안에** 있다. 픽스처에도 넣는다.
  // 이걸 빼놓았더니 게이트가 자기 탐지 문자열을 우회 흔적으로 신고하는 버그를
  // selftest 가 놓쳤다. 갓 설치한 키트를 돌려보고서야 발견했다.
  cpSync(HERE, join(root, 'scripts'), { recursive: true });

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'selftest@example.invalid');
  git(root, 'config', 'user.name', 'gate selftest');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture: clean baseline');
  const head = git(root, 'rev-parse', '--short', 'HEAD').trim();

  // 회귀 항목은 커밋 해시를 참조하므로 커밋 뒤에 쓴다.
  write(root, 'REGRESSION.md', [
    '# REGRESSION',
    '',
    '형식:',
    '',
    '```',
    '- [자동|수동] <R-ID> | <무엇을 하면 무엇이 보인다> | 의존:<파일> | 확인:<커밋해시> | mutation:<YYYY-MM-DD>',
    '```',
    '',
    '## 원장',
    '',
    `- [자동] R-001 | node --test 를 돌리면 add 테스트가 통과한다 | 의존:src/add.js | 확인:${head} | mutation:2026-09-05`,
    `- [자동] R-002 | node --test 를 돌리면 mul 테스트가 통과한다 | 의존:src/mul.js | 확인:${head} | mutation:2026-09-05`,
    '',
  ].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture: regression ledger');

  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// 각 검사의 위반 상태. 여기 적힌 것이 그 검사의 존재 이유다.
// 위반을 만드는 함수가 없는 검사는 selftest 를 통과할 수 없다 — 의도된 것이다.
// ─────────────────────────────────────────────────────────────────────────────

const VIOLATIONS = [
  {
    id: 'worktree',
    why: '미추적 파일이 있으면 다른 검사가 그 파일을 보지 못한다',
    apply(root) {
      write(root, 'src/extra.test.js', "// 커밋도 gitignore 도 되지 않은 새 테스트 파일\n");
    },
  },
  {
    id: 'tests',
    why: '테스트가 실패하면 통과가 아니다',
    apply(root) {
      // 규칙 2 — 두 번째 테스트를 깨뜨린다. 첫 테스트만 보고 멈추는 러너를 잡는다.
      write(root, 'src/mul.js', [
        'function mul(a, b) {',
        '  return a + b;   // 일부러 틀림',
        '}',
        '',
        'module.exports = { mul };',
        '',
      ].join('\n'));
    },
  },
  {
    id: 'bypass',
    why: 'TODO·스텁·하드코딩된 반환값·에러 무시로 채운 것은 구현이 아니다',
    apply(root) {
      // v1 검사 2 가 놓친 바로 그 형태. 조용히 삼키는 catch.
      write(root, 'src/io.js', [
        "const fs = require('node:fs');",
        '',
        'function readConfig(path) {',
        '  try {',
        "    return JSON.parse(fs.readFileSync(path, 'utf8'));",
        '  } catch (e) {',
        '    // Ignore',
        '  }',
        '  return {};',
        '}',
        '',
        'module.exports = { readConfig };',
        '',
      ].join('\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'violation: silent catch');
    },
  },
  {
    id: 'test_tamper',
    why: '기대값을 실제 출력에 맞춰 바꾸거나 테스트를 지우는 것은 통과가 아니다',
    apply(root) {
      write(root, 'src/add.test.js', [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "const { add } = require('./add.js');",
        '',
        "test('R-001 add sums two numbers', () => {",
        '  assert.ok(true);   // 단정을 약화시킴',
        '});',
        '',
      ].join('\n'));
    },
  },
  {
    id: 'test_deleted',
    checkId: 'test_tamper',
    why: 'v1 검사 3 은 수정을 잡았지만 삭제를 잡지 못했다',
    apply(root) {
      rmSync(join(root, 'src/add.test.js'));
    },
  },
  {
    id: 'blockers',
    why: '열린 blocker 가 있는 동안 다음 작업을 시작하지 않는다',
    apply(root) {
      write(root, 'ISSUES.md', [
        '# ISSUES',
        '',
        '형식:',
        '',
        '```',
        '- [ ] ISS-<번호> | blocker|major|minor | <R-ID> | 처리:<N단계> | <증거> | <재현 명령>',
        '```',
        '',
        '## 원장',
        '',
        '- [ ] ISS-002 | blocker | R-002 | 처리:9단계 | 먼 단계로 미뤄 둔 blocker — 그래도 게이트를 막아야 한다 | node --test',
        '',
      ].join('\n'));
    },
  },
  {
    id: 'unassigned_rid',
    why: '검증 수단이 없는 요구는 무엇을 확인할지 정의되지 않은 것이다',
    apply(root) {
      // R-003 을 명세에 추가한다. 회귀 항목도 CHECKS 항목도 테스트도 없다.
      //
      // 규칙 1 이 여기서 결정적이다. PROGRESS.md 에 R-003 을 **반드시 적는다**.
      // v1 검사 6 은 탐색 경로에 PROGRESS.md 가 들어 있어서, 계획에 적기만 하면
      // 통과했다. v1 의 수동 의례는 PROGRESS.md 없이 시험해서 이 버그를 못 봤다.
      // 실측 확인: 버그 있는 게이트에 R-099 만 넣으면 FAIL, PROGRESS.md 에도 적으면
      // PASS 였다. 그래서 이 픽스처는 PROGRESS.md 를 지우는 대신 채운다.
      write(root, 'SPEC.md', [
        '# SPEC',
        '',
        '## 기능 표',
        '',
        '| R-ID | 동작 문장 | 검증 기준 |',
        '|---|---|---|',
        '| R-001 | add(a,b) 는 두 수의 합을 돌려준다 | add(2,3) 이 정확히 5 다 |',
        '| R-002 | mul(a,b) 는 두 수의 곱을 돌려준다 | mul(2,3) 이 정확히 6 다 |',
        '| R-003 | sub(a,b) 는 두 수의 차를 돌려준다 | sub(3,2) 이 정확히 1 다 |',
        '',
      ].join('\n'));
      write(root, 'PROGRESS.md', [
        '# PROGRESS',
        '',
        '## 다음에 할 작업',
        '',
        'R-003 을 구현한다.   <- 계획에 적었을 뿐 검증 수단은 없다',
        '',
      ].join('\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'violation: R-003 planned but unverified');
    },
  },
  {
    id: 'regression',
    why: '확인 시점 이후 의존 파일이 바뀐 회귀 항목은 재확인해야 한다',
    apply(root) {
      // 규칙 2 — 두 번째 항목의 의존 파일만 바꾼다. 첫 항목은 그대로다.
      // items[0] 만 보는 게이트는 이 위반을 놓친다.
      write(root, 'src/mul.js', [
        'function mul(a, b) {',
        '  return Number(a) * Number(b);   // 동작은 같지만 의존 파일이 바뀌었다',
        '}',
        '',
        'module.exports = { mul };',
        '',
      ].join('\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'violation: second item dependency changed after 확인');
    },
  },
  {
    id: 'manual_checks',
    why: '기계가 잴 수 없는 항목의 결과 칸이 비어 있으면 아무도 확인하지 않은 것이다',
    apply(root) {
      // 규칙 2 — 첫 줄은 채워진 채로 두고 두 번째 줄만 비운다.
      write(root, 'CHECKS.md', [
        '# CHECKS — 기계가 잴 수 없어 사람이 눈으로 판정하는 것만',
        '',
        '| 항목 | 무엇을 하면 무엇이 보이는가 | 결과 |',
        '|---|---|---|',
        '| R-001 표시 | 합이 굵게 보인다 | PASS 2026-09-05 |',
        '| R-002 표시 | 곱이 파란색으로 보인다 |  |',
        '',
      ].join('\n'));
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────────────────

function runGate(cwd) {
  const r = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const verdicts = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^CHECK\s+([A-Za-z0-9_]+)\s+(PASS|FAIL|SKIP)\s*$/.exec(line);
    if (m) verdicts.set(m[1], m[2]);
  }
  return { code: r.status, out, verdicts, spawnError: r.error };
}

function main() {
  const results = [];
  let clean = null;

  // ── 특이도: 정상 상태에서 FAIL 을 내는 검사가 있는가 ──────────────────────
  {
    const root = makeCleanFixture();
    try {
      const g = runGate(root);
      if (g.spawnError) {
        console.log(`SELFTEST: 실행 불가 — gate.mjs 를 실행할 수 없다 (${GATE})`);
        console.log(`  ${g.spawnError.message}`);
        process.exit(2);
      }
      const falseAlarms = [...g.verdicts].filter(([, v]) => v === 'FAIL').map(([id]) => id);
      clean = { code: g.code, verdicts: g.verdicts, falseAlarms, out: g.out };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  if (clean.verdicts.size === 0) {
    console.log('SELFTEST: 실행 불가 — gate.mjs 가 CHECK <id> <verdict> 줄을 내지 않는다.');
    console.log('계약을 지키지 않는 게이트는 판정할 수 없다. gate.mjs 출력 형식을 먼저 맞춰라.');
    console.log('--- 게이트 출력 원문 ---');
    console.log(clean.out.trim() || '(없음)');
    process.exit(2);
  }

  // ── 민감도: 위반을 만들면 그 검사가 FAIL 을 내는가 ────────────────────────
  for (const v of VIOLATIONS) {
    const target = v.checkId || v.id;
    const root = makeCleanFixture();
    try {
      v.apply(root);
      const g = runGate(root);
      const got = g.verdicts.get(target) || '(없음)';
      results.push({
        name: v.id,
        target,
        why: v.why,
        ok: got === 'FAIL' && g.code !== 0,
        got,
        code: g.code,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ── 보고 ──────────────────────────────────────────────────────────────────
  console.log('GATE SELFTEST');
  console.log('');
  console.log(`정상 상태:  exit ${clean.code}  검사 ${clean.verdicts.size}개 인식`);
  if (clean.falseAlarms.length) {
    console.log(`  -> 거짓 경보: ${clean.falseAlarms.join(', ')} — 정상인데 FAIL 을 냈다.`);
    console.log('     거짓 경보를 내는 검사는 사람이 게이트를 통째로 무시하게 만든다. 먼저 고쳐라.');
  } else if (clean.code !== 0) {
    console.log(`  -> 정상 상태인데 exit ${clean.code} 다. 어느 검사도 FAIL 이 아닌데 통과가 아니다.`);
  } else {
    console.log('  -> 거짓 경보 없음');
  }
  console.log('');

  const width = Math.max(...results.map(r => r.name.length), 8);
  for (const r of results) {
    const mark = r.ok ? '  잡음' : '못잡음';
    console.log(`[${mark}] ${r.name.padEnd(width)}  검사 ${r.target} = ${r.got}, exit ${r.code}`);
    if (!r.ok) console.log(`           ${r.why}`);
  }

  const dead = results.filter(r => !r.ok);
  const unexercised = [...clean.verdicts.keys()]
    .filter(id => !results.some(r => r.target === id));

  console.log('');
  if (unexercised.length) {
    console.log(`위반 픽스처가 없는 검사: ${unexercised.join(', ')}`);
    console.log('  -> 실패를 낼 수 있는지 판정할 수 없다. 픽스처를 쓰거나 그 검사를 빼라.');
  }

  const bad = dead.length > 0 || clean.falseAlarms.length > 0 || unexercised.length > 0;
  console.log('');
  if (bad) {
    console.log(`SELFTEST: FAIL — 못잡음 ${dead.length} / 거짓경보 ${clean.falseAlarms.length} / 미검증 ${unexercised.length}`);
    console.log('실패를 낼 수 없는 검사는 통과에 근거를 보태지 않으면서 매 단계 비용만 먹는다.');
    console.log('고쳐서 잡히게 만들든지, 게이트에서 빼라. 그대로 두는 것만 하지 마라.');
    process.exit(1);
  }
  console.log('SELFTEST: PASS — 모든 검사가 위반을 잡고, 정상 상태에서는 조용하다.');
  process.exit(0);
}

main();
