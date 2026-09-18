"""持久层回归测试：跑 `python -m unittest discover -s server/tests -t . -v`。

覆盖的都是"错了很难看出来"的地方：
    * 会话的覆盖写语义（同 id 反复提交是更新快照，不是累加）
    * daily 物化视图与 sessions 始终一致（删会话、重建、导入之后都要对得上）
    * 书籍全量写入时章节序号重排不会让进度串到别的章节上
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest

from server.store import MojiStore


class StoreTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MojiStore(os.path.join(self.tmp.name, 'test.sqlite3'))

    def tearDown(self):
        self.tmp.cleanup()

    # ── 老库升级 ──────────────────────────────────────────────────────

    def test_opens_library_written_before_summary_and_volume(self):
        """老库（没有 summary / volume 两列）打开后应该被补上，而不是报错。

        版本升级时最容易在这里翻车：CREATE TABLE IF NOT EXISTS 对已存在的表
        一个字都不会改，不补列的话，老用户的库里这两项读出来永远是空的。
        """
        legacy = os.path.join(self.tmp.name, 'legacy.sqlite3')
        conn = sqlite3.connect(legacy)
        conn.executescript(
            'CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", '
            'author TEXT NOT NULL DEFAULT "", updated_at INTEGER NOT NULL DEFAULT 0);'
            'CREATE TABLE chapters (book_id TEXT NOT NULL, idx INTEGER NOT NULL, '
            'title TEXT NOT NULL DEFAULT "", content TEXT NOT NULL DEFAULT "", '
            'PRIMARY KEY (book_id, idx));'
        )
        conn.execute('INSERT INTO books(id, title, author, updated_at) VALUES(?, ?, ?, ?)',
                     ('b1', '旧书', '旧作者', 1))
        conn.execute('INSERT INTO chapters(book_id, idx, title, content) VALUES(?, ?, ?, ?)',
                     ('b1', 0, '第一章', '旧正文'))
        conn.commit()
        conn.close()

        store = MojiStore(legacy)                 # 打开即补列
        book = store.bootstrap()['books'][0]['book']
        self.assertEqual(book['title'], '旧书')
        self.assertEqual(book['summary'], '')     # 补出来的列给空值，不是报错
        self.assertEqual(book['chapters'][0]['content'], '旧正文')
        self.assertEqual(book['chapters'][0]['volume'], '')

    # ── 书籍与进度 ────────────────────────────────────────────────────

    def test_put_book_writes_chapters_and_progress(self):
        self.store.put_book({
            'id': 'book-1',
            'book': {
                'title': '测试书', 'author': '作者',
                'chapters': [
                    {'title': '第一章', 'content': '正文一', 'written': '正文', 'timeSpentMs': 60000},
                    {'title': '第二章', 'content': '正文二', 'written': '', 'timeSpentMs': 0},
                ],
            },
            'updatedAt': 111,
        })
        data = self.store.bootstrap()
        self.assertEqual(len(data['books']), 1)
        self.assertEqual(data['books'][0]['book']['title'], '测试书')
        self.assertEqual([c['title'] for c in data['books'][0]['book']['chapters']], ['第一章', '第二章'])
        # 正文与进度分表：chapters 只存 title/content，written 走 progress
        self.assertNotIn('written', data['books'][0]['book']['chapters'][0])
        progress = {item['index']: item for item in data['progress']}
        self.assertEqual(progress[0]['written'], '正文')
        self.assertEqual(progress[0]['elapsedMs'], 60000)

    def test_put_book_rewrites_progress_indices(self):
        """删除一章后序号整体前移：进度必须跟着新序号走，不能串到别的章节。"""
        self.store.put_book({'id': 'b', 'book': {'title': 't', 'chapters': [
            {'title': 'a', 'content': 'x', 'written': '写成这样'},
            {'title': 'b', 'content': 'y', 'written': '写成那样'},
            {'title': 'c', 'content': 'z', 'written': '写成哪样'},
        ]}})
        # 删掉第二章，从前的第三章节变成 index 1
        self.store.put_book({'id': 'b', 'book': {'title': 't', 'chapters': [
            {'title': 'a', 'content': 'x', 'written': '写成这样'},
            {'title': 'c', 'content': 'z', 'written': '写成哪样'},
        ]}})
        progress = {item['index']: item['written'] for item in self.store.bootstrap()['progress']}
        self.assertEqual(progress, {0: '写成这样', 1: '写成哪样'})

    def test_put_progress_upserts_single_row(self):
        self.store.put_book({'id': 'b', 'book': {'title': 't', 'chapters': [
            {'title': 'a', 'content': 'x'},
        ]}})
        self.store.put_progress('b', 0, '半个字', 1234)
        self.store.put_progress('b', 0, '一个字', 5678)
        rows = self.store.bootstrap()['progress']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['written'], '一个字')
        self.assertEqual(rows[0]['elapsedMs'], 5678)

    def test_delete_book_removes_everything_of_it(self):
        self.store.put_book({'id': 'b', 'book': {'title': 't', 'chapters': [
            {'title': 'a', 'content': 'x', 'written': 'y'}]}})
        self.store.delete_book('b')
        data = self.store.bootstrap()
        self.assertEqual(data['books'], [])
        self.assertEqual(data['progress'], [])

    # ── 会话与每日汇总 ────────────────────────────────────────────────

    def _session(self, session_id, day, words, duration_ms, **extra):
        return {'id': session_id, 'at': 1, 'date': day, 'bookId': 'b', 'chapterIndex': 0,
                'words': words, 'durationMs': duration_ms, **extra}

    def test_session_is_upserted_not_accumulated(self):
        """同一条会话每 5 秒覆盖提交一次：第二次必须是更新而不是相加。"""
        self.store.put_session(self._session('s1', '2026-09-17', 100, 60000))
        self.store.put_session(self._session('s1', '2026-09-17', 180, 120000))
        daily = self.store.bootstrap()['daily']
        self.assertEqual(len(daily), 1)
        self.assertEqual(daily[0]['words'], 180)
        self.assertEqual(daily[0]['durationMs'], 120000)
        self.assertEqual(daily[0]['count'], 1)

    def test_daily_is_rollup_of_sessions(self):
        self.store.put_session(self._session('s1', '2026-09-17', 100, 60000, correct=90, incorrect=10))
        self.store.put_session(self._session('s2', '2026-09-17', 200, 60000, correct=180, incorrect=20))
        self.store.put_session(self._session('s3', '2026-09-16', 50, 30000))
        by_day = {item['date']: item for item in self.store.bootstrap()['daily']}
        self.assertEqual(by_day['2026-09-17']['words'], 300)
        self.assertEqual(by_day['2026-09-17']['durationMs'], 120000)
        self.assertEqual(by_day['2026-09-17']['count'], 2)
        self.assertEqual(by_day['2026-09-17']['correct'], 270)
        self.assertEqual(by_day['2026-09-16']['words'], 50)
        # 章节维度：bookId#index -> 汇总
        self.assertEqual(by_day['2026-09-17']['chapters']['b#0']['words'], 300)

    def test_delete_session_recomputes_daily(self):
        self.store.put_session(self._session('s1', '2026-09-17', 100, 60000))
        self.store.put_session(self._session('s2', '2026-09-17', 200, 60000))
        self.store.delete_session('s2')
        detail = {item['date']: item for item in self.store.bootstrap()['daily']}['2026-09-17']
        self.assertEqual(detail['words'], 100)
        self.assertEqual(detail['count'], 1)

    def test_delete_last_session_drops_daily_row(self):
        self.store.put_session(self._session('s1', '2026-09-17', 100, 60000))
        self.store.delete_session('s1')
        self.assertEqual(self.store.bootstrap()['daily'], [])

    def test_negative_numbers_are_clamped(self):
        self.store.put_session(self._session('s1', '2026-09-17', -5, -100))
        detail = self.store.bootstrap()['daily'][0]
        self.assertEqual(detail['words'], 0)
        self.assertEqual(detail['durationMs'], 0)

    def test_rebuild_daily_from_scratch(self):
        self.store.put_session(self._session('s1', '2026-09-15', 10, 1000))
        self.store.put_session(self._session('s2', '2026-09-17', 20, 2000))
        self.store.clear_sessions()
        self.assertEqual(self.store.bootstrap()['daily'], [])

        self.store.import_payload({'sessions': [
            self._session('a', '2026-09-15', 10, 1000),
            self._session('b', '2026-09-17', 20, 2000),
        ]}, mode='merge')
        self.store.rebuild_daily()
        by_day = {item['date']: item for item in self.store.bootstrap()['daily']}
        self.assertEqual(sorted(by_day), ['2026-09-15', '2026-09-17'])
        self.assertEqual(by_day['2026-09-17']['words'], 20)

    # ── 设置与导入 ────────────────────────────────────────────────────

    def test_settings_roundtrip_keeps_type(self):
        self.store.put_setting('dailyGoal', 1200)
        self.store.put_setting('punctLenient', False)
        self.store.put_setting('nickname', '抄书人')
        values = {item['key']: item['value'] for item in self.store.bootstrap()['settings']}
        self.assertEqual(values, {'dailyGoal': 1200, 'punctLenient': False, 'nickname': '抄书人'})

    def test_import_merge_keeps_others_and_overwrites_same_id(self):
        self.store.put_book({'id': 'keep', 'book': {'title': '保留', 'chapters': []}})
        self.store.put_session(self._session('old', '2026-09-01', 5, 500))
        self.store.import_payload({
            'books': [{'id': 'new', 'book': {'title': '新增', 'chapters': []}}],
            'sessions': [self._session('old', '2026-09-01', 99, 9000)],
        }, mode='merge')
        data = self.store.bootstrap()
        self.assertEqual(sorted(book['id'] for book in data['books']), ['keep', 'new'])
        sessions = {item['id']: item for item in data['sessions']}
        self.assertEqual(sessions['old']['words'], 99)
        # daily 按 sessions 重算，不会和导入进来的旧值叠加
        self.assertEqual(data['daily'][0]['words'], 99)

    def test_import_overwrite_clears_first(self):
        self.store.put_book({'id': 'old', 'book': {'title': '旧的', 'chapters': []}})
        self.store.import_payload({'books': [{'id': 'fresh', 'book': {'title': '新的', 'chapters': []}}]},
                                  mode='overwrite')
        data = self.store.bootstrap()
        self.assertEqual([book['id'] for book in data['books']], ['fresh'])

    def test_export_payload_matches_backup_shape(self):
        self.store.put_book({'id': 'b', 'book': {'title': 't', 'chapters': [{'title': 'a', 'content': 'x'}]}})
        payload = self.store.export_payload()
        self.assertEqual(payload['app'], 'MoJi')
        self.assertEqual(payload['format'], 1)
        for key in ('books', 'progress', 'sessions', 'daily', 'settings'):
            self.assertIn(key, payload)

    def test_is_empty_flips_after_first_write(self):
        self.assertTrue(self.store.is_empty())
        self.store.put_setting('nickname', 'x')      # 只有设置，仍算空库
        self.assertTrue(self.store.is_empty())
        self.store.put_session(self._session('s1', '2026-09-17', 1, 1))
        self.assertFalse(self.store.is_empty())

    def test_persisted_across_instances(self):
        """关掉再开（新建实例）数据还在 —— 这是"重启后数据不丢"的底线。"""
        self.store.put_session(self._session('s1', '2026-09-17', 42, 4200))
        reopened = MojiStore(self.store.path)
        self.assertEqual(reopened.bootstrap()['daily'][0]['words'], 42)


if __name__ == '__main__':
    unittest.main()
