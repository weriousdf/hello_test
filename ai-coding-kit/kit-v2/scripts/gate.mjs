#!/usr/bin/env node
// gate — 단계를 닫을 자격을 코드베이스에서 기계로 확인되는 증거로만 판정한다.
//
// 이 게이트가 하는 유일한 일은 에이전트의 "완료했습니다" 를 판정 근거에서 제거하는 것이다.
// 검사 항목들은 그 원칙의 구현 세부다.
//
// 종료 코드   0 = PASS   1 = FAIL   2 = 실행 불가   3 = PARTIAL
// PARTIAL 은 통과가 아니다. 커밋해도 되는 것은 0 뿐이다.
//
// 검사의 자격은 이 파일이 아니라 gate-selftest.mjs 가 정한다.
//   확정  v1 미션에서 실제로 FAIL 을 내고 무언가를 막은 것이 관측됐다
//   유예  아직 값을 증명하지 못했다. selftest 를 통과해야 확정으로 올라간다
// 유예 검사가 selftest 에서 계속 못잡음이면 고치거나 뺀다. 그대로 두지 않는다.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ─── 설정 ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // 테스트 명령. package.json 의 scripts.test 를 쓴다. 비우면 검사가 SKIP 된다.
  testScript: 'test',
  // 테스트·골든 파일로 취급할 것. 이 파일들은 수정·삭제가 금지된다.
  testPatterns: [/\.test\.[cm]?[jt]s$/, /\.spec\.[cm]?[jt]s$/, /(^|\/)tests?\//, /(^|\/)golden\//],
  // 구현 코드로 취급할 것. 우회 흔적을 여기서만 찾는다.
  sourceExts: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'],
  // 탐색에서 제외할 디렉터리.
  skipDirs: ['node_modules', '.git', 'runs', 'dist', 'build', 'coverage', '.next'],
  // 게이트 자신의 파일. 우회 흔적 검사에서 제외한다 — 탐지 문자열이 스스로 걸린다.
  // 이 파일들은 모델이 수정할 수 없는 목록에 이미 들어 있다(AGENTS.md 금지 항목).
  gateFiles: ['scripts/gate.mjs', 'scripts/gate-selftest.mjs'],
  // R-ID 의 검증 수단으로 인정할 곳. PROGRESS.md 와 PLAN_*.md 는 의도적으로 없다 —
  // 계획에 적는 것은 검증이 아니다. v1 검사 6 이 죽어 있던 원인이 이것이었다.
  ridEvidence: ['REGRESSION.md', 'CHECKS.md'],
};

// ─── 유틸 ────────────────────────────────────────────────────────────────────
const CHECKS = [];
let hardFail = false;

function record(id, tier, verdict, headline, detail = [], fix = '') {
  console.log(`CHECK ${id} ${verdict}`);
  CHECKS.push({ id, tier, verdict, headline, detail, fix });
  if (verdict === 'FAIL') hardFail = true;
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

// 코드블록 안의 형식 예시를 데이터로 세지 않는다.
// v1 에서 사람이 blocker 를 손으로 셀 때 이것 때문에 두 번 틀렸다.
function outsideFence(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (CONFIG.skipDirs.includes(e.name)) continue;
      walk(join(dir, e.name), acc);
    } else if (e.isFile()) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

const asPosix = p => p.split(sep).join('/');
const isTestPath = p => CONFIG.testPatterns.some(re => re.test(asPosix(p)));
const isSourcePath = p => CONFIG.sourceExts.some(x => p.endsWith(x)) && !isTestPath(p);

// ─── 실행 가능 여부 ──────────────────────────────────────────────────────────
if (git('rev-parse', '--git-dir') === null) {
  console.log('CHECK _preflight SKIP');
  console.log('');
  console.log('GATE: 실행 불가 (exit 2) — git 저장소가 아니다.');
  console.log('  -> 되돌릴 수 없는 상태에서는 통과를 판정하지 않는다. git init 부터 하라.');
  process.exit(2);
}
if (git('rev-parse', '--verify', '--quiet', 'HEAD') === null) {
  console.log('CHECK _preflight SKIP');
  console.log('');
  console.log('GATE: 실행 불가 (exit 2) — 커밋이 하나도 없다.');
  console.log('  -> 회귀 항목의 확인 해시가 가리킬 지점이 없다. 첫 커밋을 먼저 만들라.');
  process.exit(2);
}

const ROOT = (git('rev-parse', '--show-toplevel') || '.').trim();

// ─── 1. worktree — 미추적 파일 ───────────────────────────────────────────────
// 유예. v1 에서 FAIL 을 냈지만 독립적인 값이 아니라 아래 검사들의 전제조건이다.
{
  const porcelain = git('status', '--porcelain') || '';
  const untracked = porcelain.split(/\r?\n/)
    .filter(l => l.startsWith('??'))
    .map(l => l.slice(3).trim())
    .filter(Boolean);
  if (untracked.length === 0) {
    record('worktree', '유예', 'PASS', '미추적 파일 0개');
  } else {
    record('worktree', '유예', 'FAIL', `미추적 파일 ${untracked.length}개`, untracked,
      'git add -N <파일> 로 등록하거나 .gitignore 에 넣어라. 미추적 파일은 아래 검사들이 보지 못한다.');
  }
}

// ─── 2. tests — 빌드·테스트 ──────────────────────────────────────────────────
// 확정. 유일하게 동작을 검증하는 검사다. v1 에서 매번 울렸다.
{
  const pkgRaw = read(join(ROOT, 'package.json'));
  let cmd = null;
  if (pkgRaw) {
    try { cmd = (JSON.parse(pkgRaw).scripts || {})[CONFIG.testScript] || null; } catch { cmd = null; }
  }
  if (!cmd) {
    record('tests', '확정', 'SKIP', '테스트 명령이 없다', [],
      '자동 검증이 없는 상태다. 이때는 manual_checks 가 유일한 동작 근거다.');
  } else {
    const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    if (r.status === 0) {
      record('tests', '확정', 'PASS', `${cmd} 통과`);
    } else {
      const tail = out.split(/\r?\n/).filter(l => /✖|fail|Error|assert/i.test(l)).slice(0, 6);
      record('tests', '확정', 'FAIL', `${cmd} 실패 (exit ${r.status})`,
        tail.length ? tail : out.split(/\r?\n/).slice(-6),
        '실패 출력 첫 줄의 파일만 고쳐라. 기대값을 실제 출력에 맞춰 바꾸는 것은 통과가 아니다.');
    }
  }
}

// ─── 3. bypass — 우회 흔적 ───────────────────────────────────────────────────
// 유예. v1 검사 2 는 한 번도 울리지 않았고, 존재 이유인 조용한 catch 를 놓쳤다.
// v2 는 (a) 표식 문자열과 (b) 본문이 비었거나 주석뿐인 catch 를 모두 본다.
{
  const MARKS = [
    /\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /\bHACK\b/,
    /NotImplemented/i, /not\s+implemented/i,
  ];
  // 평면 catch 만 잡는 어림수다. 본문에 중괄호가 있으면 무언가는 하고 있다고 본다.
  const FLAT_CATCH = /catch\s*\([^)]*\)\s*\{([^{}]*)\}/g;
  const isEmptyBody = body =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === '';

  const hits = [];
  for (const abs of walk(ROOT)) {
    const rel = asPosix(relative(ROOT, abs));
    if (!isSourcePath(rel)) continue;
    if (CONFIG.gateFiles.includes(rel)) continue;
    const text = read(abs);
    if (text === null) continue;
    const lines = outsideFence(text);
    lines.forEach((line, i) => {
      for (const re of MARKS) {
        if (re.test(line)) { hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`); break; }
      }
    });
    for (const m of text.matchAll(FLAT_CATCH)) {
      if (!isEmptyBody(m[1])) continue;
      const lineNo = text.slice(0, m.index).split(/\r?\n/).length;
      hits.push(`${rel}:${lineNo}  에러를 삼키는 catch — 본문이 비었거나 주석뿐이다`);
    }
  }
  if (hits.length === 0) {
    record('bypass', '유예', 'PASS', '우회 흔적 0줄');
  } else {
    record('bypass', '유예', 'FAIL', `우회 흔적 ${hits.length}줄`, hits.slice(0, 12),
      '못 하면 못 한다고 보고하라. 에러를 삼키면 틀린 답이 조용히 정답처럼 나온다.');
  }
}

// ─── 4. test_tamper — 기존 테스트·골든 수정·삭제 ─────────────────────────────
// 유예. v1 검사 3 은 1회 울렸으나 그것은 내 절차 설계와의 충돌이었다.
// 그리고 수정만 보고 삭제를 보지 않았다. v2 는 D 도 본다.
{
  const raw = git('diff', '--name-status', 'HEAD') || '';
  const touched = raw.split(/\r?\n/)
    .map(l => l.split('\t'))
    .filter(p => p.length >= 2 && /^[MD]/.test(p[0]) && isTestPath(p[1]))
    .map(p => `${p[0] === 'D' ? '삭제' : '수정'}  ${p[1]}`);
  if (touched.length === 0) {
    record('test_tamper', '유예', 'PASS', '기존 테스트·골든 수정·삭제 0개');
  } else {
    record('test_tamper', '유예', 'FAIL', `기존 테스트·골든 ${touched.length}개가 수정·삭제됐다`, touched,
      '테스트가 틀렸다고 판단되면 근거를 ISSUES.md 에 적고 멈춰라. 사람이 승인한 수정이라면 그 승인을 PROGRESS.md 에 남긴 뒤 커밋하라.');
  }
}

// ─── 5. blockers — 열린 blocker ──────────────────────────────────────────────
// 확정. v1 에서 ISS-001·ISS-002 가 열려 있는 동안 계속 FAIL 을 냈고,
// 결함을 안 닫고 다음 단계로 가는 것을 실제로 막았다.
{
  const text = read(join(ROOT, 'ISSUES.md'));
  if (text === null) {
    record('blockers', '확정', 'SKIP', 'ISSUES.md 가 없다', [],
      '문제 원장 없이 낸 통과는 근거가 없다.');
  } else {
    const open = outsideFence(text)
      .filter(l => /^\s*-\s*\[ \]/.test(l) && /\|\s*blocker\s*\|/.test(l))
      .map(l => l.trim());
    if (open.length === 0) {
      record('blockers', '확정', 'PASS', '열린 blocker 0건');
    } else {
      record('blockers', '확정', 'FAIL', `열린 blocker ${open.length}건`, open,
        'blocker 가 열려 있는 동안 새 작업을 시작하지 않는다. 닫는 것은 사람이 한다.');
    }
  }
}

// ─── 6. unassigned_rid — 검증 수단이 없는 요구 ───────────────────────────────
// 유예. v1 검사 6 은 탐색 경로에 PROGRESS.md 가 있어서 죽어 있었다.
// 계획에 R-ID 를 적는 것은 검증 수단이 아니다. v2 는 회귀 원장·수동 체크표·테스트만 본다.
{
  const specText = read(join(ROOT, 'SPEC.md'));
  if (specText === null) {
    record('unassigned_rid', '유예', 'SKIP', 'SPEC.md 가 없다', [],
      '대조 기준 없이 낸 통과는 근거가 없다.');
  } else {
    // 상태 칸이 '계획' 인 행은 아직 구현하지 않은 요구다. 검증 수단을 묻지 않는다.
    // 이 칸이 없으면 SPEC 의 모든 R-ID 가 검증될 때까지 게이트가 FAIL 이고, 그러면
    // 마지막 단계 전에 어떤 단계도 닫을 수 없다 — 게이트가 단계 문지기 역할을 못 한다.
    // SPEC.md 는 사람만 고치는 파일이므로 모델이 이 칸을 옮겨 검사를 피할 수 없다.
    // v1 에서는 이 검사가 PROGRESS.md 로 충족되어 죽어 있었기 때문에 이 문제가 안 드러났다.
    const planned = new Set();
    const all = new Set();
    for (const line of outsideFence(specText)) {
      if (!/^\s*\|/.test(line)) continue;
      const found = [...line.matchAll(/R-\d{3}/g)].map(m => m[0]);
      if (!found.length) continue;
      const isPlanned = /\|\s*계획\s*\|/.test(line);
      for (const r of found) { all.add(r); if (isPlanned) planned.add(r); }
    }
    const rids = [...all].filter(r => !planned.has(r)).sort();

    if (all.size === 0) {
      record('unassigned_rid', '유예', 'FAIL', 'SPEC.md 의 R-ID 가 0개', [],
        '요구가 없으면 무엇을 검증할지 정의되지 않는다. 기능 표를 먼저 채워라. (2자리 R-01 은 인식하지 않는다)');
    } else if (rids.length === 0) {
      record('unassigned_rid', '유예', 'PASS',
        `미배정 R-ID 0 / 0개 (전체 ${all.size}개가 전부 '계획' 상태다)`);
    } else {
      const haystacks = [];
      for (const name of CONFIG.ridEvidence) {
        const t = read(join(ROOT, name));
        if (t !== null) haystacks.push(t);
      }
      for (const abs of walk(ROOT)) {
        const rel = asPosix(relative(ROOT, abs));
        if (!isTestPath(rel)) continue;
        const t = read(abs);
        if (t !== null) haystacks.push(t);
      }
      const joined = haystacks.join('\n');
      const missing = rids.filter(r => !joined.includes(r));
      if (missing.length === 0) {
        record('unassigned_rid', '유예', 'PASS', `미배정 R-ID 0 / ${rids.length}개`);
      } else {
        record('unassigned_rid', '유예', 'FAIL', `미배정 R-ID ${missing.length} / ${rids.length}개 (구현 상태 기준, 전체 ${all.size}개)`,
          missing.map(r => `${r} — 검증 수단이 없다`),
          `REGRESSION.md 항목 / CHECKS.md 항목 / 테스트 중 최소 1곳이 그 R-ID 를 참조하게 만들어라. PROGRESS.md 에 적는 것은 검증이 아니다. 아직 구현 전이라면 SPEC.md 의 상태 칸이 "계획" 이어야 한다 — 그 칸은 사람만 옮긴다.`);
      }
    }
  }
}

// ─── 7. regression — 확인 이후 의존 파일이 바뀐 항목 ─────────────────────────
// 확정. v1 에서 가장 값을 한 검사다. 다만 처음에는 날짜 기준이라 죽어 있었고,
// 커밋 해시 기준으로 바꾼 뒤에야 실제로 울렸다. 날짜는 확인 값으로 인정하지 않는다.
{
  const text = read(join(ROOT, 'REGRESSION.md'));
  if (text === null) {
    record('regression', '확정', 'SKIP', 'REGRESSION.md 가 없다', [],
      '한 번 확인한 것을 적어두지 않으면 같은 것을 두 번 깨뜨린다.');
  } else {
    const items = outsideFence(text).filter(l => /^\s*-\s*\[(자동|수동)\]/.test(l) && /의존:/.test(l));
    if (items.length === 0) {
      record('regression', '확정', 'SKIP', '회귀 항목 0건', [],
        '동작을 한 번 확인했으면 항목으로 남겨라. 남기지 않으면 이 검사는 아무것도 지키지 않는다.');
    } else {
      const stale = [];
      for (const item of items) {
        const deps = (item.match(/의존:\s*([^|]+)/)?.[1] || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        const hash = item.match(/확인:\s*([0-9a-fA-F]{7,40})\b/)?.[1];
        if (!hash) {
          stale.push(`확인 칸에 커밋 해시가 없다 (날짜는 인정하지 않는다) -> ${item.trim()}`);
          continue;
        }
        if (git('rev-parse', '--verify', '--quiet', `${hash}^{commit}`) === null) {
          stale.push(`확인 커밋 ${hash} 를 찾을 수 없다 -> ${item.trim()}`);
          continue;
        }
        if (deps.length === 0) {
          stale.push(`의존 칸이 비었다 — 무엇이 바뀌면 다시 봐야 하는지 알 수 없다 -> ${item.trim()}`);
          continue;
        }
        const changed = (git('diff', '--name-only', hash, '--', ...deps) || '')
          .split(/\r?\n/).filter(Boolean);
        if (changed.length > 0) {
          stale.push(`${item.trim()}   [바뀐 의존: ${changed.join(', ')}]`);
        }
      }
      if (stale.length === 0) {
        record('regression', '확정', 'PASS', `재확인이 필요한 회귀 항목 0건 (전체 ${items.length})`);
      } else {
        record('regression', '확정', 'FAIL', `재확인이 필요한 회귀 항목 ${stale.length}건 (전체 ${items.length})`,
          stale,
          '이 항목들만 지금 다시 확인하고 확인 칸을 새 커밋 해시로 갱신하라. 전체가 아니라 겹치는 것만 하면 된다. 순서는 (1) 재확인 (2) 커밋 (3) 해시 갱신 (4) 두 번째 커밋 이다 — 미커밋 상태에서는 이 검사가 구조적으로 통과할 수 없다.');
      }
    }
  }
}

// ─── 8. manual_checks — 수동 체크표 빈칸 ─────────────────────────────────────
// 유예. v1 미션에서는 항목이 0개여서 한 번도 시험되지 않았다. 지형이 안 맞았다.
// 기계가 잴 수 없는 판정은 여기로 온다. 화면이 있는 프로젝트에서 주력이 된다.
{
  const text = read(join(ROOT, 'CHECKS.md'));
  if (text === null) {
    record('manual_checks', '유예', 'SKIP', 'CHECKS.md 가 없다', [],
      '기계가 잴 수 없는 판정을 적을 곳이 없다.');
  } else {
    const rows = outsideFence(text).filter(l => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l));
    const data = rows.slice(1); // 첫 줄은 머리글
    const blank = data.filter(l => {
      const cells = l.split('|').slice(1, -1).map(c => c.trim());
      return cells.length >= 2 && cells[cells.length - 1] === '';
    }).map(l => l.trim());
    if (blank.length === 0) {
      record('manual_checks', '유예', 'PASS', `수동 체크표 빈칸 0줄 (전체 ${data.length})`);
    } else {
      record('manual_checks', '유예', 'FAIL', `수동 체크표 빈칸 ${blank.length}줄 (전체 ${data.length})`,
        blank,
        '결과 칸은 사람이 직접 해보고 채운다. 모델이 채우면 이 표는 존재 이유를 잃는다.');
    }
  }
}

// ─── 보고 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`GATE v2  (${new Date().toISOString().slice(0, 10)})`);
console.log('');
const width = Math.max(...CHECKS.map(c => c.id.length));
for (const c of CHECKS) {
  console.log(`[${c.verdict.padEnd(4)}] ${c.id.padEnd(width)}  ${c.tier}  ${c.headline}`);
  if (c.verdict === 'FAIL' || (c.verdict === 'SKIP' && c.fix)) {
    if (c.fix) console.log(`        -> ${c.fix}`);
    for (const d of c.detail) console.log(`        | ${d}`);
  }
}

const fails = CHECKS.filter(c => c.verdict === 'FAIL');
const skips = CHECKS.filter(c => c.verdict === 'SKIP');
console.log('');
if (fails.length > 0) {
  console.log(`GATE: FAIL (${fails.length}건, SKIP ${skips.length}건) — '->' 줄을 처리하기 전에 다음 작업을 시작하지 마라.`);
  process.exit(1);
}
if (skips.length > 0) {
  console.log(`GATE: PARTIAL (SKIP ${skips.length}건) — 통과가 아니다. SKIP 은 '검사하지 못했다' 는 뜻이다.`);
  process.exit(3);
}
console.log(`GATE: PASS — 검사 ${CHECKS.length}개 전부 실행됐고 전부 통과했다. 커밋은 사람이 찍는다.`);
process.exit(0);
