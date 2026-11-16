# Capture API v1

All routes, including health, require `X-Capture-Token`. Never use query tokens.
The server does not accept cookies or share another service's authentication.
JSON request bodies are limited to 8192 bytes; binary chunks to `max_chunk_bytes`.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/browser-capture/health` | service and schema_version |
| POST | `/api/browser-capture/start` | JSON below; 201 with session_id |
| POST | `/api/browser-capture/{id}/chunk/{sequence}` | binary audio; 200 acknowledgment |
| POST | `/api/browser-capture/{id}/finish` | complete, final_sequence, reason |
| GET | `/api/browser-capture/{id}` | session summary |

Start JSON:
```json
{"room_id":"123456","room_url":"https://live.bilibili.com/123456","mime_type":"audio/webm;codecs=opus","audio_tracks":1,"title":"Example","browser":"Example browser","player_muted":true}
```

Chunks: sequences start at 1, at most 100000. Send `X-Capture-Mime` matching the
session's base MIME: audio/webm, audio/ogg, or audio/mp4. Server calculates SHA-256
and persists it. Optional `X-Capture-SHA256` must match if supplied (the inherited
browser protocol relies on HTTPS plus server-side digesting, not a client digest).
Same sequence and same bytes is idempotent; different bytes returns 409. Sealed
sessions reject further uploads. The server reads all transport frames with a
bounded iterator; it never treats a single 16 KiB read as a complete request.

Finish JSON:
```json
{"complete":true,"final_sequence":2,"reason":"user"}
```

Repeated finish is idempotent. `completed` means complete was requested, a nonempty
sequence has no gaps, no unexpected sequence, and stored digests match actual
fragments. Otherwise status is `incomplete`. No absent browser fragments can be
recovered by the server. The media validity field is independent:
`valid`, `invalid`, `unchecked` (tools absent), or `validation_failed`.
FFprobe must identify audio and FFmpeg must decode without reported errors for valid.
This checks decoding, not speech presence, loudness or correct room attribution.

On disk: `sessions/{id}/session.json`, `events.jsonl`, `chunks/chunk_00000001.bin`,
and `capture.webm`, `capture.ogg` or `capture.m4a`. Metadata schema_version=1,
room_id, started_at/ended_at (UTC), sequence/digest inventory, capture_sha256,
media_validity and stop_reason form the stable external-worker contract. Files are
not served publicly; ASR reads the spool through a separately secured mechanism.
API summaries do not disclose absolute server paths.

401 auth; 400 validation/MIME/digest mismatch; 404 missing resource; 409 sealed or
conflicting sequence; 413 request size; 507 capacity; 500 unexpected storage failure.
No list, delete, transcription or NowFeed publication API is provided.
