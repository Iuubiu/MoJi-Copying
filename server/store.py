"""墨迹 · SQLite 持久层。

为什么是 SQLite
    这是单机应用：一个文件就是全部数据，不用装数据库服务，
    备份就是把这个文件复制走。实践中的写入模式是"练习中每 5 秒写一条
    会话快照 + 打字时防抖写单章进度"，用 WAL 模式让读写互不阻塞。

为什么每请求一个连接
    sqlite3 的连接不能跨线程使用（check_same_thread），而 HTTP 服务是多线程的。
    本地文件 + WAL 下开连接很便宜，每请求开关一次换来的是"不用操心并发"。

数据形态
    books / chapters / progress / sessions / daily / settings 六张表，
    与前端 v3 的六个 IndexedDB store 一一对应 —— 老用户第一次打开
    新版本时，前端会把 IndexedDB 里的全量数据 POST /api/import 进来。
    daily 是 sessions 的物化视图：session 一写入就在同一事务里重算，
    保证"统计口径只有一个来源"（sessions），daily 只是查询缓存。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id         TEXT PRIMARY KEY,
  title      TEXT    NOT NULL DEFAULT '',
  author     TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chapters (
  book_id TEXT    NOT NULL,
  idx     INTEGER NOT NULL,
  title   TEXT    NOT NULL DEFAULT '',
  content TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE IF NOT EXISTS progress (
  id         TEXT PRIMARY KEY,
  book_id    TEXT    NOT NULL,
  idx        INTEGER NOT NULL,
  written    TEXT    NOT NULL DEFAULT '',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS progress_book ON progress(book_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL DEFAULT 0,
  date          TEXT    NOT NULL DEFAULT '',
  book_id       TEXT    NOT NULL DEFAULT '',
  book_title    TEXT    NOT NULL DEFAULT '',
  chapter_index INTEGER NOT NULL DEFAULT 0,
  chapter_title TEXT    NOT NULL DEFAULT '',
  words         INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  correct       INTEGER NOT NULL DEFAULT 0,
  incorrect     INTEGER NOT NULL DEFAULT 0,
  final         INTEGER NOT NULL DEFAULT 0,
  legacy        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS sessions_at ON sessions(at);

CREATE TABLE IF NOT EXISTS daily (
  date        TEXT PRIMARY KEY,
  words       INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  count       INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  incorrect   INTEGER NOT NULL DEFAULT 0,
  chapters    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _number(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _text(value, default=''):
    return value if isinstance(value, str) else default


class MojiStore:
    """一个数据库文件 = 一份完整数据。"""

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._lock = threading.Lock()          # 只保护"建表"这一次性动作
        self._ensure_schema()

    # ── 连接 ──────────────────────────────────────────────────────────────

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute('PRAGMA journal_mode = WAL')
                conn.executescript(_SCHEMA)
                conn.execute(
                    'INSERT INTO meta(key, value) VALUES(?, ?) '
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                    ('schema_version', str(SCHEMA_VERSION)),
                )

    # ── 读取 ──────────────────────────────────────────────────────────────

    def is_empty(self) -> bool:
        """库里一条书、一条练习记录都没有 —— 前端据此决定要不要做旧数据迁移。"""
        with self._connect() as conn:
            books = conn.execute('SELECT COUNT(*) AS n FROM books').fetchone()['n']
            sessions = conn.execute('SELECT COUNT(*) AS n FROM sessions').fetchone()['n']
        return books == 0 and sessions == 0

    def bootstrap(self) -> dict:
        """前端启动时一次性取全量：六个集合的形状与 IndexedDB 记录一致，
        这样前端的数据层只是"换了传输方式"，业务代码一行不用动。"""
        with self._connect() as conn:
            books = [dict(row) for row in conn.execute(
                'SELECT id, title, author, updated_at FROM books ORDER BY updated_at DESC')]
            chapters = [dict(row) for row in conn.execute(
                'SELECT book_id, idx, title, content FROM chapters ORDER BY book_id, idx')]
            progress = [dict(row) for row in conn.execute(
                'SELECT id, book_id, idx, written, elapsed_ms, updated_at FROM progress')]
            sessions = [dict(row) for row in conn.execute(
                'SELECT * FROM sessions ORDER BY at DESC')]
            daily = [dict(row) for row in conn.execute('SELECT * FROM daily')]
            settings = [dict(row) for row in conn.execute('SELECT key, value FROM settings')]

        by_book = {}
        for chapter in chapters:
            by_book.setdefault(chapter['book_id'], []).append(chapter)

        return {
            'books': [{
                'id': row['id'],
                'book': {
                    'title': row['title'],
                    'author': row['author'],
                    'chapters': [{'title': c['title'], 'content': c['content']}
                                 for c in by_book.get(row['id'], [])],
                },
                'updatedAt': row['updated_at'],
            } for row in books],
            'progress': [{
                'id': row['id'], 'bookId': row['book_id'], 'index': row['idx'],
                'written': row['written'], 'elapsedMs': row['elapsed_ms'],
                'updatedAt': row['updated_at'],
            } for row in progress],
            'sessions': [self._session_out(row) for row in sessions],
            'daily': [self._daily_out(row) for row in daily],
            'settings': [{'key': row['key'], 'value': self._json_load(row['value'])}
                         for row in settings],
        }

    def export_payload(self) -> dict:
        """备份文件的内容：与旧版"导出备份"生成的 JSON 完全同构。"""
        data = self.bootstrap()
        return {
            'app': 'MoJi',
            'format': 1,
            'books': data['books'],
            'progress': data['progress'],
            'sessions': data['sessions'],
            'daily': data['daily'],
            'settings': data['settings'],
        }

    @staticmethod
    def _session_out(row) -> dict:
        return {
            'id': row['id'], 'at': row['at'], 'date': row['date'],
            'bookId': row['book_id'], 'bookTitle': row['book_title'],
            'chapterIndex': row['chapter_index'], 'chapterTitle': row['chapter_title'],
            'words': row['words'], 'durationMs': row['duration_ms'],
            'correct': row['correct'], 'incorrect': row['incorrect'],
            'final': bool(row['final']), 'legacy': bool(row['legacy']),
        }

    @staticmethod
    def _daily_out(row) -> dict:
        try:
            chapters = json.loads(row['chapters'])
        except ValueError:
            chapters = {}
        return {
            'date': row['date'], 'words': row['words'], 'durationMs': row['duration_ms'],
            'count': row['count'], 'correct': row['correct'], 'incorrect': row['incorrect'],
            'chapters': chapters if isinstance(chapters, dict) else {},
        }

    @staticmethod
    def _json_load(raw):
        try:
            return json.loads(raw)
        except ValueError:
            return raw

    # ── 书籍 ──────────────────────────────────────────────────────────────

    def put_book(self, payload: dict) -> None:
        """整本写入：书的元信息 + 章节正文 + 每章进度。

        章节增删会让后续章节的序号整体前移，而 progress 是按键（bookId-index）
        存的 —— 所以这里"先清空该书再按新序号重写"，与前端旧版
        rewriteProgressForBook 的意图一致，只是搬到了同一个事务里。
        """
        book_id = _text(payload.get('id'))
        if not book_id:
            raise ValueError('book.id 不能为空')
        book = payload.get('book') or {}
        chapters = book.get('chapters') if isinstance(book.get('chapters'), list) else []
        updated_at = _number(payload.get('updatedAt'), 0) or int(time.time() * 1000)

        with self._connect() as conn:
            conn.execute(
                'INSERT INTO books(id, title, author, updated_at) VALUES(?, ?, ?, ?) '
                'ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, '
                'updated_at = excluded.updated_at',
                (book_id, _text(book.get('title'), '未命名书籍'), _text(book.get('author'), '本地文本'), updated_at),
            )
            conn.execute('DELETE FROM chapters WHERE book_id = ?', (book_id,))
            conn.execute('DELETE FROM progress WHERE book_id = ?', (book_id,))
            for index, chapter in enumerate(chapters):
                if not isinstance(chapter, dict):
                    continue
                conn.execute(
                    'INSERT INTO chapters(book_id, idx, title, content) VALUES(?, ?, ?, ?)',
                    (book_id, index, _text(chapter.get('title'), f'第 {index + 1} 章'),
                     _text(chapter.get('content'))),
                )
                conn.execute(
                    'INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) '
                    'VALUES(?, ?, ?, ?, ?, ?)',
                    (f'{book_id}-{index}', book_id, index, _text(chapter.get('written')),
                     _number(chapter.get('timeSpentMs')), updated_at),
                )

    def delete_book(self, book_id: str) -> None:
        with self._connect() as conn:
            conn.execute('DELETE FROM chapters WHERE book_id = ?', (book_id,))
            conn.execute('DELETE FROM progress WHERE book_id = ?', (book_id,))
            conn.execute('DELETE FROM books WHERE id = ?', (book_id,))

    def put_progress(self, book_id: str, index: int, written: str, elapsed_ms: int) -> dict:
        """单章进度：打字时高频调用，只碰一行。"""
        record_id = f'{book_id}-{index}'
        now = int(time.time() * 1000)
        with self._connect() as conn:
            conn.execute(
                'INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) '
                'VALUES(?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(id) DO UPDATE SET written = excluded.written, '
                'elapsed_ms = excluded.elapsed_ms, updated_at = excluded.updated_at',
                (record_id, book_id, index, _text(written), _number(elapsed_ms), now),
            )
        return {'id': record_id, 'bookId': book_id, 'index': index,
                'written': _text(written), 'elapsedMs': _number(elapsed_ms), 'updatedAt': now}

    # ── 会话 / 每日 ───────────────────────────────────────────────────────

    def put_session(self, record: dict) -> dict:
        """写入（或覆盖）一次会话，并重算它所属那一天的汇总。

        覆盖写是设计的一部分：练习中每 5 秒落一次库，同一条 recordId
        反复提交的是"这段会话的最新快照"，不是累加。
        """
        session_id = _text(record.get('id'))
        if not session_id:
            raise ValueError('session.id 不能为空')
        day = _text(record.get('date'))
        if not day:
            raise ValueError('session.date 不能为空')

        with self._connect() as conn:
            conn.execute(
                'INSERT INTO sessions(id, at, date, book_id, book_title, chapter_index, chapter_title, '
                'words, duration_ms, correct, incorrect, final, legacy) '
                'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(id) DO UPDATE SET at = excluded.at, date = excluded.date, '
                'book_id = excluded.book_id, book_title = excluded.book_title, '
                'chapter_index = excluded.chapter_index, chapter_title = excluded.chapter_title, '
                'words = excluded.words, duration_ms = excluded.duration_ms, '
                'correct = excluded.correct, incorrect = excluded.incorrect, final = excluded.final',
                (session_id, _number(record.get('at')), day,
                 _text(record.get('bookId')), _text(record.get('bookTitle')),
                 _number(record.get('chapterIndex')), _text(record.get('chapterTitle')),
                 max(0, _number(record.get('words'))), max(0, _number(record.get('durationMs'))),
                 max(0, _number(record.get('correct'))), max(0, _number(record.get('incorrect'))),
                 1 if record.get('final') else 0, 1 if record.get('legacy') else 0),
            )
            daily = self._refresh_daily(conn, day)
        return daily

    @staticmethod
    def _refresh_daily(conn, day: str) -> dict:
        """把某一天从 sessions 重新聚合（rollupDaily 的 SQL 版本）。"""
        rows = conn.execute(
            'SELECT book_id, chapter_index, words, duration_ms, correct, incorrect '
            'FROM sessions WHERE date = ?', (day,),
        ).fetchall()
        if not rows:
            conn.execute('DELETE FROM daily WHERE date = ?', (day,))
            return {'date': day, 'words': 0, 'durationMs': 0, 'count': 0,
                    'correct': 0, 'incorrect': 0, 'chapters': {}}

        words = sum(row['words'] for row in rows)
        duration = sum(row['duration_ms'] for row in rows)
        correct = sum(row['correct'] for row in rows)
        incorrect = sum(row['incorrect'] for row in rows)
        chapters = {}
        for row in rows:
            key = f"{row['book_id']}#{row['chapter_index']}"
            bucket = chapters.setdefault(key, {'words': 0, 'durationMs': 0, 'count': 0})
            bucket['words'] += row['words']
            bucket['durationMs'] += row['duration_ms']
            bucket['count'] += 1

        record = {'date': day, 'words': words, 'durationMs': duration, 'count': len(rows),
                  'correct': correct, 'incorrect': incorrect, 'chapters': chapters}
        conn.execute(
            'INSERT INTO daily(date, words, duration_ms, count, correct, incorrect, chapters) '
            'VALUES(:date, :words, :durationMs, :count, :correct, :incorrect, :chapters) '
            'ON CONFLICT(date) DO UPDATE SET words = excluded.words, '
            'duration_ms = excluded.duration_ms, count = excluded.count, '
            'correct = excluded.correct, incorrect = excluded.incorrect, chapters = excluded.chapters',
            {**record, 'chapters': json.dumps(chapters, ensure_ascii=False)},
        )
        return record

    def rebuild_daily(self) -> dict:
        """按 sessions 整体重算 daily（导入备份、清空记录后调用）。"""
        with self._connect() as conn:
            days = [row['date'] for row in conn.execute(
                'SELECT DISTINCT date FROM sessions WHERE date <> "" ORDER BY date')]
            conn.execute('DELETE FROM daily')
            for day in days:
                self._refresh_daily(conn, day)
            return {'days': len(days)}

    def clear_sessions(self) -> None:
        with self._connect() as conn:
            conn.execute('DELETE FROM sessions')
            conn.execute('DELETE FROM daily')

    def delete_session(self, session_id: str) -> None:
        with self._connect() as conn:
            row = conn.execute('SELECT date FROM sessions WHERE id = ?', (session_id,)).fetchone()
            if row is None:
                return
            conn.execute('DELETE FROM sessions WHERE id = ?', (session_id,))
            self._refresh_daily(conn, row['date'])

    # ── 设置 ──────────────────────────────────────────────────────────────

    def put_setting(self, key: str, value) -> None:
        with self._connect() as conn:
            conn.execute(
                'INSERT INTO settings(key, value) VALUES(?, ?) '
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                (key, json.dumps(value, ensure_ascii=False)),
            )

    def get_setting(self, key: str, default=None):
        with self._connect() as conn:
            row = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        return self._json_load(row['value']) if row else default

    # ── 导入 ──────────────────────────────────────────────────────────────

    def import_payload(self, payload: dict, mode: str = 'merge') -> dict:
        """接收旧版备份格式（或旧 IndexedDB 的全量导出）。

        overwrite：先清空六个集合，再整体写入。
        merge：按 id 覆盖同名记录、保留其余 —— 与旧版前端的合并语义一致。
        """
        if mode not in ('merge', 'overwrite'):
            raise ValueError("mode 只能是 merge 或 overwrite")

        books = payload.get('books') if isinstance(payload.get('books'), list) else []
        progress = payload.get('progress') if isinstance(payload.get('progress'), list) else []
        sessions = payload.get('sessions') if isinstance(payload.get('sessions'), list) else []
        settings = payload.get('settings') if isinstance(payload.get('settings'), list) else []

        now = int(time.time() * 1000)
        with self._connect() as conn:
            if mode == 'overwrite':
                for table in ('books', 'chapters', 'progress', 'sessions', 'daily', 'settings'):
                    conn.execute(f'DELETE FROM {table}')

            imported_books = 0
            for record in books:
                if not isinstance(record, dict):
                    continue
                book = record.get('book') or {}
                chapters = book.get('chapters') if isinstance(book.get('chapters'), list) else []
                book_id = _text(record.get('id'))
                if not book_id:
                    continue
                conn.execute(
                    'INSERT INTO books(id, title, author, updated_at) VALUES(?, ?, ?, ?) '
                    'ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, '
                    'updated_at = excluded.updated_at',
                    (book_id, _text(book.get('title'), '未命名书籍'), _text(book.get('author'), '本地文本'),
                     _number(record.get('updatedAt'), now)),
                )
                imported_books += 1
                if not chapters:
                    continue
                conn.execute('DELETE FROM chapters WHERE book_id = ?', (book_id,))
                for index, chapter in enumerate(chapters):
                    if not isinstance(chapter, dict):
                        continue
                    conn.execute(
                        'INSERT INTO chapters(book_id, idx, title, content) VALUES(?, ?, ?, ?)',
                        (book_id, index, _text(chapter.get('title'), f'第 {index + 1} 章'),
                         _text(chapter.get('content'))),
                    )

            for record in progress:
                if not isinstance(record, dict):
                    continue
                record_id = _text(record.get('id'))
                book_id = _text(record.get('bookId'))
                if not record_id or not book_id:
                    continue
                conn.execute(
                    'INSERT INTO progress(id, book_id, idx, written, elapsed_ms, updated_at) '
                    'VALUES(?, ?, ?, ?, ?, ?) '
                    'ON CONFLICT(id) DO UPDATE SET written = excluded.written, '
                    'elapsed_ms = excluded.elapsed_ms, updated_at = excluded.updated_at',
                    (record_id, book_id, _number(record.get('index')), _text(record.get('written')),
                     _number(record.get('elapsedMs')), _number(record.get('updatedAt'), now)),
                )

            imported_sessions = 0
            for record in sessions:
                if not isinstance(record, dict) or not record.get('id'):
                    continue
                if not _text(record.get('date')):
                    continue
                conn.execute(
                    'INSERT INTO sessions(id, at, date, book_id, book_title, chapter_index, chapter_title, '
                    'words, duration_ms, correct, incorrect, final, legacy) '
                    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                    'ON CONFLICT(id) DO UPDATE SET at = excluded.at, date = excluded.date, '
                    'book_id = excluded.book_id, book_title = excluded.book_title, '
                    'chapter_index = excluded.chapter_index, chapter_title = excluded.chapter_title, '
                    'words = excluded.words, duration_ms = excluded.duration_ms, '
                    'correct = excluded.correct, incorrect = excluded.incorrect, final = excluded.final',
                    (_text(record.get('id')), _number(record.get('at')), _text(record.get('date')),
                     _text(record.get('bookId')), _text(record.get('bookTitle')),
                     _number(record.get('chapterIndex')), _text(record.get('chapterTitle')),
                     max(0, _number(record.get('words'))), max(0, _number(record.get('durationMs'))),
                     max(0, _number(record.get('correct'))), max(0, _number(record.get('incorrect'))),
                     1 if record.get('final') else 0, 1 if record.get('legacy') else 0),
                )
                imported_sessions += 1

            for record in settings:
                if not isinstance(record, dict) or 'key' not in record:
                    continue
                conn.execute(
                    'INSERT INTO settings(key, value) VALUES(?, ?) '
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                    (_text(record.get('key')), json.dumps(record.get('value'), ensure_ascii=False)),
                )

            # daily 一律从 sessions 重算：备份里的旧值可能已经和 sessions 不一致
            conn.execute('DELETE FROM daily')
            days = [row['date'] for row in conn.execute(
                'SELECT DISTINCT date FROM sessions WHERE date <> "" ORDER BY date')]
            for day in days:
                self._refresh_daily(conn, day)

        return {'books': imported_books, 'sessions': imported_sessions, 'days': len(days),
                'mode': mode}
