import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from aiohttp.test_utils import TestClient, TestServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.app import create_app, STORE_KEY

class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = {'token': 'x'*48, 'output_root': self.tmp.name, 'max_chunk_bytes': 65536, 'min_free_bytes': 0}
        self.app = create_app(self.cfg)
        self.store = self.app[STORE_KEY]
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.auth = {'X-Capture-Token': self.cfg['token']}
        self.payload = {'room_id':'123456', 'room_url':'https://live.bilibili.com/123456', 'mime_type':'audio/webm', 'audio_tracks':1}
    async def asyncTearDown(self):
        await self.client.close()
    async def start(self, mime='audio/webm'):
        r = await self.client.post('/api/browser-capture/start', json={**self.payload, 'mime_type':mime}, headers=self.auth)
        self.assertEqual(r.status, 201, await r.text())
        return (await r.json())['session_id']
    async def test_auth(self):
        for headers in ({}, {'X-Capture-Token':'wrong'}):
            r = await self.client.post('/api/browser-capture/start', json=self.payload, headers=headers)
            self.assertEqual(r.status,401)
    async def test_multiframe_duplicate_conflict_and_hash(self):
        sid=await self.start(); data=bytes(range(256))*200
        async def frames():
            for i in range(0,len(data),16375):
                yield data[i:i+16375]; await asyncio.sleep(.01)
        url=f'/api/browser-capture/{sid}/chunk/1'
        headers={**self.auth,'X-Capture-Mime':'audio/webm','X-Capture-SHA256':hashlib.sha256(data).hexdigest()}
        r=await self.client.post(url,data=frames(),headers=headers); self.assertEqual(r.status,200,await r.text())
        r=await self.client.post(url,data=data,headers=headers); self.assertTrue((await r.json())['duplicate'])
        r=await self.client.post(url,data=b'wrong',headers={**self.auth,'X-Capture-Mime':'audio/webm'}); self.assertEqual(r.status,409)
        r=await self.client.post(url,data=b'wrong',headers=headers); self.assertEqual(r.status,400)
        r=await self.client.post(f'/api/browser-capture/{sid}/finish',json={'complete':True,'final_sequence':1},headers=self.auth)
        m=await r.json(); self.assertEqual(m['status'],'completed'); self.assertEqual(m['media_validity'],'invalid')
        self.assertEqual((self.store.session_dir(sid)/'capture.webm').read_bytes(),data)
        r=await self.client.post(f'/api/browser-capture/{sid}/finish',json={},headers=self.auth); self.assertEqual((await r.json())['status'],'completed')
    async def test_oversize_chunked_and_json(self):
        sid=await self.start()
        async def frames():
            yield b'x'*40000; yield b'x'*40000
        r=await self.client.post(f'/api/browser-capture/{sid}/chunk/1',data=frames(),headers={**self.auth,'X-Capture-Mime':'audio/webm'}); self.assertEqual(r.status,413)
        r=await self.client.post('/api/browser-capture/start',data='x'*9000,headers=self.auth); self.assertEqual(r.status,413)
        r=await self.client.post('/api/browser-capture/start',json=[],headers=self.auth); self.assertEqual(r.status,400)
    async def test_capacity(self):
        self.store.max_total_bytes=1
        r=await self.client.post('/api/browser-capture/start',json=self.payload,headers=self.auth); self.assertEqual(r.status,507)
    async def test_restart_seals_incomplete(self):
        sid=await self.start(); self.store.append_chunk(sid,1,b'partial','audio/webm')
        await self.client.close()
        app=create_app(self.cfg)
        try:
            self.assertEqual(app[STORE_KEY].summary(sid)['status'],'incomplete')
        finally:
            # Run cleanup through a real test server lifecycle.
            c=TestClient(TestServer(app)); await c.start_server(); await c.close()
    async def test_media_containers(self):
        for mime,ext,codec in [('audio/webm','webm','libopus'),('audio/ogg','ogg','libopus'),('audio/mp4','m4a','aac')]:
            with self.subTest(mime=mime):
                path=Path(self.tmp.name)/('synthetic.'+ext)
                subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a',codec,str(path)],check=True)
                data=path.read_bytes(); sid=await self.start(mime)
                # Continuous MediaRecorder stream fragments must be byte-concatenated.
                for n,chunk in enumerate([data[:1000],data[1000:]],1):
                    r=await self.client.post(f'/api/browser-capture/{sid}/chunk/{n}',data=chunk,headers={**self.auth,'X-Capture-Mime':mime}); self.assertEqual(r.status,200)
                r=await self.client.post(f'/api/browser-capture/{sid}/finish',json={'complete':True,'final_sequence':2},headers=self.auth)
                m=await r.json(); self.assertEqual(m['status'],'completed'); self.assertEqual(m['media_validity'],'valid')
                self.assertEqual((self.store.session_dir(sid)/m['capture_file']).read_bytes(),data)
