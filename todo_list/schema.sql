-- Todo 앱 스키마. 전부 IF NOT EXISTS 라서 서버가 뜰 때마다 실행해도 안전하다.

-- SQLite 는 외래키를 연결마다 직접 켜야 한다. 안 켜면 ON DELETE CASCADE 가
-- 아무 일도 하지 않고 todo_tags 에 고아 행이 조용히 쌓인다.
PRAGMA foreign_keys = ON;

-- 할 일 하나가 한 행. 기본 CRUD 네 기능이 전부 이 표에서 끝난다.
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY,
  title      TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  notes      TEXT,
  is_done    INTEGER NOT NULL DEFAULT 0 CHECK (is_done IN (0, 1)),
  -- SQLite 에는 DATE 타입이 없다. TEXT 에 'YYYY-MM-DD' 로만 넣어야
  -- 사전순 정렬이 날짜순과 일치한다. GLOB 검사가 '2026/09/07' 같은 값을 입구에서 막는다.
  due_date   TEXT    CHECK (due_date IS NULL OR
                            due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 태그 이름의 원본. 이름을 바꿀 때 한 행만 고치면 된다.
CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  color TEXT
);

-- 할 일과 태그를 잇는 연결표. 자기 데이터는 없고 연결만 담는다.
-- 자기 id 가 필요 없으므로 WITHOUT ROWID 로 숨은 행 번호를 만들지 않는다.
CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (todo_id, tag_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_todos_open_due ON todos(is_done, due_date);
CREATE INDEX IF NOT EXISTS idx_todo_tags_tag  ON todo_tags(tag_id);

-- 수정 시각 자동 갱신. WHEN 절이 없으면 recursive_triggers 가 켜진 환경에서
-- 트리거가 자기를 무한히 호출한다.
CREATE TRIGGER IF NOT EXISTS trg_todos_updated_at
AFTER UPDATE ON todos FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE todos SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id;
END;
