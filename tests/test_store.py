import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from capture_store import BrowserCaptureStore  # noqa: E402


class BrowserCaptureStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "live_data").mkdir()
        self.token = "browser-token-" + ("x" * 48)
        self.cfg = {
            "enabled": True,
            "token": self.token,
            "output_root": "live_data/browser_capture",
            "max_chunk_bytes": 65536,
        }
        self.store = BrowserCaptureStore(self.cfg, self.repo)
        self.payload = {
            "room_id": "123456",
            "room_url": "https://live.bilibili.com/123456",
            "title": "My own test stream",
            "browser": "Chrome test",
            "mime_type": "audio/webm;codecs=opus",
            "audio_tracks": 1,
            "player_muted": True,
        }

    def test_token_and_output_root_are_scoped(self):
        self.assertTrue(self.store.authorized(self.token))
        self.assertFalse(self.store.authorized("wrong"))

    def test_start_append_deduplicate_and_finish(self):
        started = self.store.start(self.payload)
        sid = started["session_id"]
        self.assertTrue(sid.endswith("_room123456_" + sid.rsplit("_", 1)[1]))
        first = b"webm-init-and-cluster-1"
        second = b"cluster-2"
        one = self.store.append_chunk(sid, 1, first, "audio/webm;codecs=opus")
        self.assertFalse(one["duplicate"])
        duplicate = self.store.append_chunk(sid, 1, first, "audio/webm")
        self.assertTrue(duplicate["duplicate"])
        two = self.store.append_chunk(sid, 2, second, "audio/webm;codecs=opus")
        self.assertEqual(two["chunks_received"], 2)

        finished = self.store.finish(sid, {
            "complete": True, "final_sequence": 2, "reason": "user"
        })
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["chunks_received"], 2)
        self.assertEqual(finished["missing_sequences"], [])
        folder = self.store.session_dir(sid)
        self.assertEqual((folder / "capture.webm").read_bytes(), first + second)
        metadata = json.loads((folder / "session.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["source"], "browser_capture")
        self.assertEqual(metadata["room_id"], "123456")
        self.assertEqual(metadata["capture_file"], "capture.webm")
        self.assertEqual(metadata["status"], "completed")
        self.assertTrue((folder / "events.jsonl").exists())

    def test_finish_marks_missing_chunks_incomplete(self):
        sid = self.store.start(self.payload)["session_id"]
        self.store.append_chunk(sid, 1, b"first", "audio/webm")
        self.store.append_chunk(sid, 3, b"third", "audio/webm")
        result = self.store.finish(sid, {
            "complete": True, "final_sequence": 3, "reason": "user"
        })
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["missing_sequences"], [2])

    def test_rejects_bad_room_url_mime_and_track_count(self):
        with self.assertRaisesRegex(ValueError, "room_url"):
            self.store.start({**self.payload, "room_url": "https://evil.example/123456"})
        with self.assertRaisesRegex(ValueError, "MIME"):
            self.store.start({**self.payload, "mime_type": "video/webm"})
        with self.assertRaisesRegex(ValueError, "audio track"):
            self.store.start({**self.payload, "audio_tracks": 0})

    def test_rejects_wrong_mime_empty_and_oversized_chunks(self):
        sid = self.store.start(self.payload)["session_id"]
        with self.assertRaisesRegex(ValueError, "MIME"):
            self.store.append_chunk(sid, 1, b"audio", "audio/ogg")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.store.append_chunk(sid, 1, b"", "audio/webm")
        with self.assertRaises(OverflowError):
            self.store.append_chunk(sid, 1, b"x" * 65537, "audio/webm")

    def test_session_id_path_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError, "session id"):
            self.store.summary("../../etc/passwd")

    def test_corrupt_and_unexpected_sequences_are_incomplete(self):
        sid = self.store.start(self.payload)["session_id"]
        self.store.append_chunk(sid, 1, b"original", "audio/webm")
        self.store.append_chunk(sid, 2, b"extra", "audio/webm")
        (self.store.session_dir(sid) / "chunks/chunk_00000001.bin").write_bytes(b"corrupt")
        result = self.store.finish(sid, {"complete": True, "final_sequence": 1})
        self.assertEqual(result["status"], "incomplete")
        meta = json.loads((self.store.session_dir(sid)/"session.json").read_text())
        self.assertEqual(meta["corrupt_sequences"], [1])
        self.assertEqual(meta["unexpected_sequences"], [2])

    def test_disabled_store_rejects_start(self):
        disabled = BrowserCaptureStore({**self.cfg, "enabled": False}, self.repo)
        with self.assertRaises(PermissionError):
            disabled.start(self.payload)


if __name__ == "__main__":
    unittest.main()
