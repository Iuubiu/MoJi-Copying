"""墨迹 · REST API 路由。

为什么要自己写路由
    整个后端只有十来个端点，标准库够用。少一个第三方依赖，
    "下载即用"和桌面版打包都简单 —— 这是这个项目一贯的取舍。

形态
    后端只做持久化（CRUD + 每日汇总物化），不做业务计算：
    统计口径、校对、进度百分比仍然由前端算 —— stats.js 是纯函数，
    有 82 项 Node 回归测试盯着，把它复制成 Python 会立刻失去那层保护。
    所以这里所有端点都是"存"和"取"，没有"算"。
"""

from __future__ import annotations

import json
import re
import urllib.parse

APP_VERSION = '2.0.0'


class ApiError(Exception):
    """带 HTTP 状态码的业务错误，由 HTTP 层统一翻译成 JSON 错误体。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _require_dict(body, what: str) -> dict:
    if not isinstance(body, dict):
        raise ApiError(400, f'{what} 的请求体必须是 JSON 对象')
    return body


# ── 端点 ────────────────────────────────────────────────────────────────

def health(store, _params, _query, _body):
    return 200, {
        'ok': True,
        'app': 'MoJi',
        'version': APP_VERSION,
        'storage': 'sqlite',
        'dbPath': store.path,
        'empty': store.is_empty(),
    }


def bootstrap(store, _params, _query, _body):
    return 200, store.bootstrap()


def export_backup(store, _params, _query, _body):
    payload = store.export_payload()
    payload['exportedAt'] = _now_iso()
    payload['version'] = APP_VERSION
    return 200, payload


def import_backup(store, _params, query, body):
    payload = _require_dict(body, '导入')
    mode = (query.get('mode') or ['merge'])[0]
    if mode not in ('merge', 'overwrite'):
        raise ApiError(400, "mode 只能是 merge 或 overwrite")
    if payload.get('app') not in (None, 'MoJi'):
        raise ApiError(400, '这不是墨迹的备份文件')
    result = store.import_payload(payload, mode)
    return 200, {'ok': True, **result}


def put_book(store, params, _query, body):
    record = _require_dict(body, '书籍')
    record = {**record, 'id': params['book_id']}
    store.put_book(record)
    return 200, {'ok': True, 'id': params['book_id']}


def delete_book(store, params, _query, _body):
    store.delete_book(params['book_id'])
    return 200, {'ok': True, 'id': params['book_id']}


def put_progress(store, params, _query, body):
    payload = _require_dict(body, '章节进度')
    record = store.put_progress(
        params['book_id'], int(params['index']),
        payload.get('written') or '', payload.get('elapsedMs') or 0,
    )
    return 200, {'ok': True, 'progress': record}


def put_session(store, params, _query, body):
    record = _require_dict(body, '练习会话')
    record = {**record, 'id': params['session_id']}
    daily = store.put_session(record)
    return 200, {'ok': True, 'daily': daily}


def delete_session(store, params, _query, _body):
    store.delete_session(params['session_id'])
    return 200, {'ok': True}


def clear_sessions(store, _params, _query, _body):
    store.clear_sessions()
    return 200, {'ok': True}


def put_setting(store, params, _query, body):
    payload = _require_dict(body, '设置')
    store.put_setting(params['key'], payload.get('value'))
    return 200, {'ok': True, 'key': params['key']}


def rebuild_daily(store, _params, _query, _body):
    return 200, {'ok': True, **store.rebuild_daily()}


# 顺序即优先级；pattern 用 ^...$ 全匹配，路径参数在 (?P<name>...) 里取。
ROUTES = (
    ('GET', re.compile(r'^/api/health$'), health),
    ('GET', re.compile(r'^/api/bootstrap$'), bootstrap),
    ('GET', re.compile(r'^/api/export$'), export_backup),
    ('POST', re.compile(r'^/api/import$'), import_backup),
    ('POST', re.compile(r'^/api/rebuild$'), rebuild_daily),
    ('DELETE', re.compile(r'^/api/sessions$'), clear_sessions),
    ('PUT', re.compile(r'^/api/books/(?P<book_id>[^/]+)$'), put_book),
    ('DELETE', re.compile(r'^/api/books/(?P<book_id>[^/]+)$'), delete_book),
    ('PUT', re.compile(r'^/api/books/(?P<book_id>[^/]+)/progress/(?P<index>\d+)$'), put_progress),
    ('PUT', re.compile(r'^/api/sessions/(?P<session_id>[^/]+)$'), put_session),
    ('DELETE', re.compile(r'^/api/sessions/(?P<session_id>[^/]+)$'), delete_session),
    ('PUT', re.compile(r'^/api/settings/(?P<key>[^/]+)$'), put_setting),
)

ALLOWED_METHODS = sorted({method for method, _pattern, _handler in ROUTES} | {'OPTIONS', 'HEAD'})


def handle(store, method: str, raw_path: str, raw_body: bytes) -> tuple[int, dict]:
    """把一次请求翻译成 (status, payload)。

    raw_path 是**含查询串**的原始路径（如 /api/import?mode=overwrite）：
    查询串只有这一层看得到，上游剥掉就没法再解析了。
    """
    body = None
    if raw_body:
        try:
            body = json.loads(raw_body.decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as error:
            raise ApiError(400, f'请求体不是合法 JSON：{error}') from error

    parsed = urllib.parse.urlparse(raw_path)
    route_path = urllib.parse.unquote(parsed.path)
    query = urllib.parse.parse_qs(parsed.query)

    allowed = set()
    for route_method, pattern, handler in ROUTES:
        match = pattern.match(route_path)
        if not match:
            continue
        if route_method != method:
            allowed.add(route_method)
            continue
        params = {key: urllib.parse.unquote(value) for key, value in match.groupdict().items()}
        return handler(store, params, query, body)

    if allowed:
        raise ApiError(405, f'{method} 不被支持，可用：{", ".join(sorted(allowed))}')
    raise ApiError(404, f'未知的 API 路径：{route_path}')


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')
