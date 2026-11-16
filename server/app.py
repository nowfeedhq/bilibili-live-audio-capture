"""Standalone, single-process capture HTTP service."""
import argparse
import asyncio
import json
from pathlib import Path
import fcntl
from aiohttp import web
from .capture_store import BrowserCaptureStore


STORE_KEY = web.AppKey("capture_store", BrowserCaptureStore)

def create_app(config, root=None):
    store = BrowserCaptureStore({**config, 'enabled': True}, Path(root or '.').resolve())
    lockfile = (store.root / '.server.lock').open('a')
    try:
        fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lockfile.close()
        raise RuntimeError('another capture server owns this output root') from None
    store.recover()
    lock = asyncio.Lock()

    @web.middleware
    async def errors(request, handler):
        if not store.authorized(request.headers.get('X-Capture-Token', '')):
            raise web.HTTPUnauthorized(text='invalid capture token')
        try:
            return await handler(request)
        except FileExistsError:
            raise web.HTTPConflict(text='conflicting chunk') from None
        except FileNotFoundError:
            raise web.HTTPNotFound(text='session not found') from None
        except OverflowError:
            raise web.HTTPInsufficientStorage(text='capture capacity exceeded') from None
        except (ValueError, TypeError, UnicodeError):
            raise web.HTTPBadRequest(text='invalid request') from None
        except RuntimeError:
            raise web.HTTPConflict(text='session is sealed') from None

    app = web.Application(client_max_size=store.max_chunk_bytes, middlewares=[errors])
    async def body(request, limit):
        # Read ALL transport frames, never a single content.read(n) prefix.
        if request.content_length is not None and request.content_length > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=request.content_length)
        chunks = bytearray()
        async for block in request.content.iter_chunked(16384):
            chunks.extend(block)
            if len(chunks) > limit:
                raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(chunks))
        return bytes(chunks)

    async def handle(request):
        action = request.match_info.get('action', '')
        sid = request.match_info.get('sid')
        if request.method == 'GET':
            if action == 'health':
                return web.json_response({'service': 'nowfeed-capture', 'schema_version': 1})
            async with lock:
                return web.json_response(await asyncio.to_thread(store.summary, sid))
        limit = store.max_chunk_bytes if 'sequence' in request.match_info else 8192
        raw = await body(request, limit)
        async with lock:
            if 'sequence' in request.match_info:
                digest = request.headers.get('X-Capture-SHA256')
                if digest:
                    import hashlib
                    if digest != hashlib.sha256(raw).hexdigest():
                        raise web.HTTPBadRequest(text='SHA-256 mismatch')
                result = await asyncio.to_thread(store.append_chunk, sid, int(request.match_info['sequence']), raw, request.headers.get('X-Capture-Mime', ''))
            elif action == 'start':
                result = await asyncio.to_thread(store.start, json.loads(raw))
            else:
                result = await asyncio.to_thread(store.finish, sid, json.loads(raw))
        return web.json_response(result, status=201 if action == 'start' else 200)

    prefix = '/api/browser-capture'
    app.router.add_get(prefix + '/{action:health}', handle)
    app.router.add_post(prefix + '/{action:start}', handle)
    sid = r'{sid:\d{8}_\d{6}_browser_room\d{1,12}_[0-9a-f]{8}}'
    app.router.add_get(prefix + '/' + sid, handle)
    app.router.add_post(prefix + '/' + sid + '/{action:finish}', handle)
    app.router.add_post(prefix + '/' + sid + r'/chunk/{sequence:\d{1,6}}', handle)
    async def close(_):
        lockfile.close()
    app.on_cleanup.append(close)
    app[STORE_KEY] = store
    return app


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--config', default='server/config.json')
    args = p.parse_args()
    config = json.loads(Path(args.config).read_text())
    web.run_app(create_app(config), host=config.get('host', '127.0.0.1'), port=int(config.get('port', 8765)), access_log=None)

if __name__ == '__main__':
    main()
