"""HTTP 层回归测试：起一个真服务，用 urllib 把端点全部走一遍。

刻意不打桩：被打桩的服务测不出"路由写错、CORS 头没发、Host 校验漏了"
这类问题，而它们恰恰是本地服务最容易出的事。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request

from server.http_app import AppServer


def _write_web_stub(root: str) -> None:
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, 'index.html'), 'w', encoding='utf-8') as handle:
        handle.write('<!doctype html><html lang="zh-CN"><title>墨迹测试</title></html>')
    with open(os.path.join(root, 'manifest.webmanifest'), 'w', encoding='utf-8') as handle:
        handle.write('{"name": "墨迹测试", "icons": []}')


class ApiTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        web = os.path.join(cls.tmp.name, 'web')
        _write_web_stub(web)
        cls.reports = []
        cls.server = AppServer(
            root=web,
            db_path=os.path.join(cls.tmp.name, 'api.sqlite3'),
            preferred_port=0,                      # 让系统分配，别去抢常用端口
            on_boot_report=cls.reports.append,
        )
        url = cls.server.start()
        cls.base = cls.server.origin
        assert url.endswith('/index.html')

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.tmp.cleanup()

    def setUp(self):
        # 每个用例都从干净状态开始：清空数据（保留 AppServer 与端口）
        self.request('DELETE', '/api/sessions')
        self.request('POST', '/api/import', {'app': 'MoJi'}, query='?mode=overwrite')

    # ── 工具 ──────────────────────────────────────────────────────────

    def request(self, method, path, payload=None, origin=None, host=None, query=''):
        data = json.dumps(payload).encode('utf-8') if payload is not None else None
        request = urllib.request.Request(self.base + path + query, data=data, method=method)
        if data:
            request.add_header('Content-Type', 'application/json')
        if origin:
            request.add_header('Origin', origin)
        if host:
            request.add_header('Host', host)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read().decode('utf-8')
                parsed = json.loads(body) if body else None
                return response.status, parsed, dict(response.headers)
        except urllib.error.HTTPError as error:
            try:
                body = error.read().decode('utf-8')
            finally:
                error.close()
            parsed = json.loads(body) if body else None
            return error.code, parsed, dict(error.headers)

    def put_book(self, book_id='book-1', chapters=None):
        chapters = chapters if chapters is not None else [
            {'title': '第一章', 'content': '正文一', 'written': '正文', 'timeSpentMs': 30000},
            {'title': '第二章', 'content': '正文二', 'written': '', 'timeSpentMs': 0},
        ]
        return self.request('PUT', f'/api/books/{book_id}',
                            {'id': book_id, 'book': {'title': '测试书', 'author': '作者', 'chapters': chapters}})

    def put_session(self, session_id='s-1', day='2026-09-17', words=100, duration=60000):
        return self.request('PUT', f'/api/sessions/{session_id}', {
            'id': session_id, 'at': 1700000000000, 'date': day, 'bookId': 'book-1',
            'bookTitle': '测试书', 'chapterIndex': 0, 'chapterTitle': '第一章',
            'words': words, 'durationMs': duration, 'correct': words, 'incorrect': 0, 'final': False,
        })

    # ── 健康检查与全量读取 ────────────────────────────────────────────

    def test_health_reports_storage_and_emptiness(self):
        status, payload, _ = self.request('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertTrue(payload['ok'])
        self.assertEqual(payload['storage'], 'sqlite')
        self.assertTrue(payload['dbPath'].endswith('.sqlite3'))
        self.assertTrue(payload['empty'])

    def test_bootstrap_shape(self):
        status, payload, _ = self.request('GET', '/api/bootstrap')
        self.assertEqual(status, 200)
        for key in ('books', 'progress', 'sessions', 'daily', 'settings'):
            self.assertIn(key, payload)
        self.assertEqual(payload['books'], [])

    # ── 书籍与进度 ────────────────────────────────────────────────────

    def test_put_book_then_bootstrap(self):
        status, payload, _ = self.put_book()
        self.assertEqual(status, 200)
        _, data, _ = self.request('GET', '/api/bootstrap')
        self.assertEqual(data['books'][0]['book']['title'], '测试书')
        self.assertEqual(len(data['books'][0]['book']['chapters']), 2)
        self.assertEqual(data['progress'][0]['written'], '正文')
        # 写完书，库就不算空了
        _, health, _ = self.request('GET', '/api/health')
        self.assertFalse(health['empty'])

    def test_put_progress_single_chapter(self):
        self.put_book()
        status, payload, _ = self.request('PUT', '/api/books/book-1/progress/1',
                                          {'written': '第二章写了一点', 'elapsedMs': 9000})
        self.assertEqual(status, 200)
        self.assertEqual(payload['progress']['written'], '第二章写了一点')
        _, data, _ = self.request('GET', '/api/bootstrap')
        by_index = {item['index']: item for item in data['progress']}
        self.assertEqual(by_index[1]['elapsedMs'], 9000)
        self.assertEqual(by_index[0]['written'], '正文')      # 别的章节不受影响

    def test_delete_book(self):
        self.put_book()
        status, _, _ = self.request('DELETE', '/api/books/book-1')
        self.assertEqual(status, 200)
        _, data, _ = self.request('GET', '/api/bootstrap')
        self.assertEqual(data['books'], [])
        self.assertEqual(data['progress'], [])

    # ── 会话与每日汇总 ────────────────────────────────────────────────

    def test_put_session_returns_recomputed_daily(self):
        self.put_session('s-1', words=100, duration=60000)
        status, payload, _ = self.put_session('s-1', words=180, duration=120000)
        self.assertEqual(status, 200)
        # 覆盖写：第二次提交的是"这段会话的最新快照"，不是再记一笔
        self.assertEqual(payload['daily']['words'], 180)
        self.assertEqual(payload['daily']['durationMs'], 120000)
        self.assertEqual(payload['daily']['count'], 1)

    def test_daily_aggregates_multiple_sessions(self):
        self.put_session('s-1', words=100, duration=60000)
        self.put_session('s-2', words=200, duration=60000)
        self.put_session('s-3', day='2026-09-16', words=50, duration=30000)
        _, data, _ = self.request('GET', '/api/bootstrap')
        by_day = {item['date']: item for item in data['daily']}
        self.assertEqual(by_day['2026-09-17']['words'], 300)
        self.assertEqual(by_day['2026-09-17']['count'], 2)
        self.assertEqual(by_day['2026-09-16']['words'], 50)

    def test_clear_sessions_wipes_daily_too(self):
        self.put_session('s-1')
        status, _, _ = self.request('DELETE', '/api/sessions')
        self.assertEqual(status, 200)
        _, data, _ = self.request('GET', '/api/bootstrap')
        self.assertEqual(data['sessions'], [])
        self.assertEqual(data['daily'], [])

    # ── 设置 ──────────────────────────────────────────────────────────

    def test_settings_roundtrip(self):
        self.request('PUT', '/api/settings/dailyGoal', {'value': 1200})
        self.request('PUT', '/api/settings/punctLenient', {'value': False})
        _, data, _ = self.request('GET', '/api/bootstrap')
        values = {item['key']: item['value'] for item in data['settings']}
        self.assertEqual(values, {'dailyGoal': 1200, 'punctLenient': False})

    # ── 备份 ──────────────────────────────────────────────────────────

    def test_export_then_import_overwrite(self):
        self.put_book()
        self.put_session('s-1', words=123, duration=4567)
        _, payload, _ = self.request('GET', '/api/export')
        self.assertEqual(payload['app'], 'MoJi')
        self.assertEqual(payload['books'][0]['id'], 'book-1')

        # 清空后从备份整体恢复
        self.request('POST', '/api/import', {'app': 'MoJi'}, query='?mode=overwrite')
        status, result, _ = self.request('POST', '/api/import', payload, query='?mode=overwrite')
        self.assertEqual(status, 200)
        self.assertEqual(result['books'], 1)
        _, data, _ = self.request('GET', '/api/bootstrap')
        self.assertEqual(data['books'][0]['id'], 'book-1')
        self.assertEqual(data['daily'][0]['words'], 123)

    def test_import_merge_overwrites_same_session_only(self):
        self.put_session('keep', words=10)
        self.put_session('same', words=20)
        self.request('POST', '/api/import', {'app': 'MoJi', 'sessions': [
            {'id': 'same', 'date': '2026-09-17', 'words': 99, 'durationMs': 9900},
            {'id': 'fresh', 'date': '2026-09-17', 'words': 5, 'durationMs': 500},
        ]}, query='?mode=merge')
        _, data, _ = self.request('GET', '/api/bootstrap')
        sessions = {item['id']: item for item in data['sessions']}
        self.assertEqual(sessions['keep']['words'], 10)
        self.assertEqual(sessions['same']['words'], 99)
        self.assertEqual(sessions['fresh']['words'], 5)
        self.assertEqual(data['daily'][0]['words'], 10 + 99 + 5)

    def test_import_rejects_foreign_payload(self):
        status, payload, _ = self.request('POST', '/api/import', {'app': 'OtherApp'})
        self.assertEqual(status, 400)
        self.assertIn('error', payload)

    # ── 错误路径与安全 ────────────────────────────────────────────────

    def test_unknown_path_and_method(self):
        status, payload, _ = self.request('GET', '/api/nope')
        self.assertEqual(status, 404)
        self.assertIn('error', payload)
        status, _, _ = self.request('PATCH', '/api/health')
        self.assertEqual(status, 405)

    def test_bad_json_body(self):
        request = urllib.request.Request(self.base + '/api/sessions/s-x', data=b'{not json',
                                         method='PUT')
        request.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status = response.status
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            status = error.code
            body = json.loads(error.read().decode())
        self.assertEqual(status, 400)
        self.assertIn('JSON', body['error'])

    def test_non_local_host_is_rejected(self):
        status, payload, _ = self.request('GET', '/api/health', host='evil.example.com')
        self.assertEqual(status, 403)

    def test_cors_only_for_local_origins(self):
        _, _, headers = self.request('GET', '/api/health', origin='http://127.0.0.1:5173')
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173')
        _, _, headers = self.request('GET', '/api/health', origin='https://evil.example.com')
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_options_preflight(self):
        status, _, headers = self.request('OPTIONS', '/api/sessions/s-1', origin='http://localhost:5173')
        self.assertEqual(status, 204)
        self.assertIn('PUT', headers.get('Access-Control-Allow-Methods', ''))

    # ── 静态资源与自检通道 ────────────────────────────────────────────

    def test_manifest_is_served_with_correct_mime(self):
        """浏览器只认 application/manifest+json 的 manifest，发成 octet-stream 就白给。"""
        with urllib.request.urlopen(self.base + '/manifest.webmanifest', timeout=10) as response:
            content_type = response.headers.get('Content-Type')
            body = json.loads(response.read().decode('utf-8'))
        self.assertEqual(response.status, 200)
        self.assertEqual(content_type, 'application/manifest+json')
        self.assertIn('icons', body)

    def test_static_index_is_served(self):
        with urllib.request.urlopen(self.base + '/index.html', timeout=10) as response:
            html = response.read().decode('utf-8')
        self.assertEqual(response.status, 200)
        self.assertIn('墨迹测试', html)

    def test_boot_report_endpoint(self):
        with urllib.request.urlopen(self.base + '/__boot-report?d=%7B%22stage%22%3A%22ready%22%7D',
                                    timeout=10) as response:
            self.assertEqual(response.status, 204)
        self.assertTrue(any(item.get('stage') == 'ready' for item in self.reports))

    def test_missing_file_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.base + '/nope.js', timeout=10)
        self.assertEqual(caught.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
