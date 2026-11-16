from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
import subprocess
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4


SESSION_RE = re.compile(r"^\d{8}_\d{6}_browser_room\d{1,12}_[0-9a-f]{8}$")
ROOM_RE = re.compile(r"^\d{1,12}$")
MIME_EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
}
DEFAULT_MAX_CHUNK_BYTES = 2 * 1024 * 1024
MAX_SEQUENCE = 100_000
MAX_SESSION_BYTES = 1024 * 1024 * 1024


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise FileNotFoundError(path) from None
    if not isinstance(data, dict):
        raise ValueError("invalid session metadata")
    return data


def clean_text(value: Any, limit: int) -> str:
    text = str(value or "")
    text = "".join(ch for ch in text if ch >= " " and ch not in "\x7f")
    return text[:limit].strip()


def mime_base(value: str) -> str:
    return str(value or "").split(";", 1)[0].strip().lower()


class BrowserCaptureStore:
    """Token-authenticated spool for audio-only browser captures."""

    def __init__(self, cfg: dict[str, Any], repo_root: Path):
        self.cfg = cfg
        self.enabled = cfg.get("enabled") is True
        self.token = str(cfg.get("token") or "")
        if self.enabled and not 40 <= len(self.token) <= 256:
            raise ValueError("browser capture token must contain at least 40 characters")

        root = Path(str(cfg.get("output_root") or "recordings")).expanduser()
        if not root.is_absolute():
            root = repo_root / root
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_total_bytes = int(cfg.get("max_total_bytes", 10 * 1024**3))
        self.min_free_bytes = int(cfg.get("min_free_bytes", 512 * 1024**2))
        self.sessions_root = self.root / "sessions"
        self.max_chunk_bytes = int(cfg.get("max_chunk_bytes") or DEFAULT_MAX_CHUNK_BYTES)
        self.max_chunk_bytes = max(64 * 1024, min(self.max_chunk_bytes, 8 * 1024 * 1024))

    def authorized(self, supplied: str) -> bool:
        return (
            self.enabled
            and bool(supplied)
            and len(supplied) <= 256
            and secrets.compare_digest(supplied, self.token)
        )

    def session_dir(self, session_id: str) -> Path:
        if not SESSION_RE.fullmatch(str(session_id)):
            raise ValueError("invalid capture session id")
        folder = self.sessions_root / session_id
        if folder.is_symlink() or (folder.exists() and self.sessions_root.resolve() not in folder.resolve().parents):
            raise ValueError("invalid session path")
        return folder

    def _load(self, session_id: str) -> tuple[Path, dict[str, Any]]:
        folder = self.session_dir(session_id)
        metadata = read_json(folder / "session.json")
        return folder, metadata

    def _event(self, folder: Path, event: str, **fields: Any) -> None:
        path = folder / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"ts": now_utc(), "event": event, **fields}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def check_capacity(self, additional=0):
        used = sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())
        if used + additional > self.max_total_bytes or shutil.disk_usage(self.root).free - additional < self.min_free_bytes:
            raise OverflowError("capture disk capacity limit reached")

    def recover(self):
        # Single server process owns this spool. Interrupted sessions are never completed.
        for path in self.sessions_root.glob("*/session.json"):
            m = read_json(path)
            if m.get("status") == "recording":
                self.finish(m["session_id"], {"complete": False, "reason": "server_restart"})

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise PermissionError("browser capture is disabled")
        if not isinstance(payload, dict):
            raise ValueError("expected JSON object")

        room_id = str(payload.get("room_id") or "")
        if not ROOM_RE.fullmatch(room_id):
            raise ValueError("room_id must be a numeric Bilibili room ID")

        parsed = urlsplit(str(payload.get("room_url") or ""))
        parts = [part for part in parsed.path.split("/") if part]
        if (
            parsed.scheme != "https"
            or parsed.hostname != "live.bilibili.com"
            or parsed.username is not None
            or not parts
            or parts[0] != room_id
        ):
            raise ValueError("room_url must match https://live.bilibili.com/<room_id>")

        full_mime = clean_text(payload.get("mime_type"), 100)
        base_mime = mime_base(full_mime)
        if base_mime not in MIME_EXTENSIONS:
            raise ValueError("unsupported MediaRecorder MIME type")

        try:
            audio_tracks = int(payload.get("audio_tracks") or 0)
        except (TypeError, ValueError):
            raise ValueError("invalid audio track count") from None
        if not 1 <= audio_tracks <= 8:
            raise ValueError("capture must contain 1..8 audio tracks")

        self.check_capacity(65536)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        session_id = f"{stamp}_browser_room{room_id}_{uuid4().hex[:8]}"
        folder = self.session_dir(session_id)
        (folder / "chunks").mkdir(parents=True, exist_ok=False)

        metadata = {
            "schema_version": 1,
            "session_id": session_id,
            "source": "browser_capture",
            "capture_method": "HTMLMediaElement.captureStream",
            "room_id": room_id,
            "room_url": f"https://live.bilibili.com/{room_id}",
            "room_snapshot": {"title": clean_text(payload.get("title"), 300)},
            "browser": clean_text(payload.get("browser"), 300),
            "mime_type": full_mime,
            "mime_type_base": base_mime,
            "audio_tracks": audio_tracks,
            "player_muted": payload.get("player_muted") is True,
            "started_at": now_utc(),
            "ended_at": None,
            "status": "recording",
            "chunks_received": 0,
            "bytes_received": 0,
            "last_sequence": 0,
            "chunks": [],
        }
        atomic_json(folder / "session.json", metadata)
        self._event(
            folder,
            "capture_started",
            room_id=room_id,
            mime_type=full_mime,
            audio_tracks=audio_tracks,
        )
        return {
            "ok": True,
            "session_id": session_id,
            "chunk_seconds": 15,
            "max_chunk_bytes": self.max_chunk_bytes,
            "output_root": "sessions",
        }

    def append_chunk(
        self, session_id: str, sequence: int, data: bytes, supplied_mime: str
    ) -> dict[str, Any]:
        if not self.enabled:
            raise PermissionError("browser capture is disabled")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= MAX_SEQUENCE:
            raise ValueError("invalid chunk sequence")
        if not isinstance(data, bytes) or not data:
            raise ValueError("empty audio chunk")
        if len(data) > self.max_chunk_bytes:
            raise OverflowError("audio chunk exceeds configured limit")

        folder, metadata = self._load(session_id)
        if metadata.get("status") != "recording":
            raise RuntimeError("capture session is not recording")
        if mime_base(supplied_mime) != metadata.get("mime_type_base"):
            raise ValueError("chunk MIME type does not match capture session")

        current_bytes = int(metadata.get("bytes_received") or 0)
        digest = hashlib.sha256(data).hexdigest()
        target = folder / "chunks" / f"chunk_{sequence:08d}.bin"
        if target.exists():
            existing_digest = hashlib.sha256(target.read_bytes()).hexdigest()
            if secrets.compare_digest(existing_digest, digest) and any(c["sequence"] == sequence for c in metadata.get("chunks", [])):
                return {
                    "ok": True,
                    "duplicate": True,
                    "sequence": sequence,
                    "chunks_received": int(metadata.get("chunks_received") or 0),
                    "bytes_received": current_bytes,
                }
            if not secrets.compare_digest(existing_digest, digest):
                raise FileExistsError("chunk sequence already exists with different content")

        if current_bytes + len(data) > MAX_SESSION_BYTES:
            raise OverflowError("capture session reached the 1 GiB safety limit")

        self.check_capacity(len(data) + 65536)
        tmp = target.with_suffix(".tmp")
        with tmp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(target)

        chunks = list(metadata.get("chunks") or [])
        chunks.append({
            "sequence": sequence,
            "bytes": len(data),
            "sha256": digest,
            "received_at": now_utc(),
        })
        chunks.sort(key=lambda item: int(item["sequence"]))
        metadata.update({
            "chunks": chunks,
            "chunks_received": len(chunks),
            "bytes_received": current_bytes + len(data),
            "last_sequence": max(sequence, int(metadata.get("last_sequence") or 0)),
            "last_chunk_at": now_utc(),
        })
        atomic_json(folder / "session.json", metadata)
        self._event(folder, "chunk_received", sequence=sequence, bytes=len(data), sha256=digest)
        return {
            "ok": True,
            "duplicate": False,
            "sequence": sequence,
            "chunks_received": len(chunks),
            "bytes_received": metadata["bytes_received"],
        }

    def finish(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise PermissionError("browser capture is disabled")
        if not isinstance(payload, dict):
            raise ValueError("expected JSON object")

        folder, metadata = self._load(session_id)
        if metadata.get("status") != "recording":
            return self.summary(session_id)

        try:
            final_sequence = payload.get("final_sequence", metadata.get("last_sequence", 0))
            if isinstance(final_sequence, bool) or not isinstance(final_sequence, int):
                raise ValueError("invalid final sequence")
        except (TypeError, ValueError):
            raise ValueError("invalid final sequence") from None
        if not 0 <= final_sequence <= MAX_SEQUENCE:
            raise ValueError("invalid final sequence")

        chunks_dir = folder / "chunks"
        available = {
            int(match.group(1)): path
            for path in chunks_dir.glob("chunk_*.bin")
            if (match := re.fullmatch(r"chunk_(\d{8})\.bin", path.name))
        }
        missing = [n for n in range(1, final_sequence + 1) if n not in available]
        complete_requested = payload.get("complete") is True
        expected = {int(c["sequence"]): c for c in metadata.get("chunks", [])}
        corrupt = [n for n, p in available.items() if n not in expected or
                   hashlib.sha256(p.read_bytes()).hexdigest() != expected[n]["sha256"]]
        unexpected = sorted(n for n in available if n > final_sequence)
        complete = complete_requested and not missing and not corrupt and not unexpected and final_sequence > 0

        capture_file = None
        assembled_bytes = 0
        capture_sha256 = None
        if available:
            self.check_capacity(sum(p.stat().st_size for p in available.values()))
            extension = MIME_EXTENSIONS[metadata["mime_type_base"]]
            output = folder / ("capture" + extension)
            tmp = output.with_suffix(output.suffix + ".tmp")
            digest = hashlib.sha256()
            with tmp.open("wb") as handle:
                for sequence in sorted(available):
                    with available[sequence].open("rb") as source:
                        while True:
                            block = source.read(1024 * 1024)
                            if not block:
                                break
                            handle.write(block)
                            digest.update(block)
                            assembled_bytes += len(block)
                handle.flush()
                os.fsync(handle.fileno())
            tmp.replace(output)
            capture_file = output.name
            capture_sha256 = digest.hexdigest()

        media_validity = "unchecked"
        if capture_file and shutil.which("ffmpeg") and shutil.which("ffprobe"):
            try:
                probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "json", str(folder / capture_file)], capture_output=True, timeout=30)
                audio = json.loads(probe.stdout).get("streams", []) if probe.returncode == 0 else []
                decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", str(folder / capture_file), "-map", "0:a:0", "-f", "null", "-"], capture_output=True, timeout=120)
                media_validity = "valid" if audio and decoded.returncode == 0 and not decoded.stderr.strip() else "invalid"
            except (subprocess.TimeoutExpired, ValueError, OSError):
                media_validity = "validation_failed"
        metadata.update({
            "media_validity": media_validity,
            "corrupt_sequences": corrupt,
            "unexpected_sequences": unexpected,
            "ended_at": now_utc(),
            "status": "completed" if complete else "incomplete",
            "stop_reason": clean_text(payload.get("reason") or "user", 100),
            "final_sequence": final_sequence,
            "missing_sequences": missing,
            "capture_file": capture_file,
            "assembled_bytes": assembled_bytes,
            "capture_sha256": capture_sha256,
        })
        atomic_json(folder / "session.json", metadata)
        self._event(
            folder,
            "capture_finished",
            status=metadata["status"],
            final_sequence=final_sequence,
            missing_sequences=missing,
            assembled_bytes=assembled_bytes,
        )
        return self.summary(session_id)

    def summary(self, session_id: str) -> dict[str, Any]:
        folder, metadata = self._load(session_id)
        return {
            "ok": True,
            "session_id": session_id,
            "status": metadata.get("status"),
            "chunks_received": metadata.get("chunks_received", 0),
            "bytes_received": metadata.get("bytes_received", 0),
            "capture_file": metadata.get("capture_file"),
            "assembled_bytes": metadata.get("assembled_bytes", 0),
            "missing_sequences": metadata.get("missing_sequences", []),
            "media_validity": metadata.get("media_validity", "unchecked"),
            "capture_sha256": metadata.get("capture_sha256"),
        }
