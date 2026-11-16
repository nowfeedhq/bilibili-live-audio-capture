# External ASR integration (not a runtime component)

1. Scan session.json files with status completed **and** media_validity valid.
   Read metadata again after discovering it; metadata is atomically replaced.
   Verify capture_sha256 against capture_file before consumption. Never read `.tmp`.
2. Use a separately deployed worker with read-only spool access, or transfer the
   sealed audio through your own authenticated queue/storage. This project contains
   no ASR dispatcher, worker, model, credentials or network dependency.
3. Normalize media with FFmpeg if the ASR service requires PCM; submit the assembled
   stream (not individual MediaRecorder fragments). Ask ASR for segment start/end
   seconds relative to the recording start. Preserve room_id, session_id and UTC
   started_at; derive wall clock timestamps as started_at + segment offset, noting
   browser buffering can introduce timing drift.
4. Store a transcript with session_id, capture_sha256, ASR model/version, language,
   and segments [{start_seconds, end_seconds, text}]. Hand that separate artifact to
   a future NowFeed ingestion adapter. No NowFeed endpoint is implemented here.
5. Give the worker its own persistent job ledger. Use
   (session_id, capture_sha256, ASR model/version) as an idempotency key; claim jobs
   atomically, retry transient failures with capped exponential backoff, and retain
   a terminal error for review. Write transcript output atomically and mark consumed
   only after durable output. A crashed worker may redeliver; downstream ingestion
   must upsert on the same key. Do not mutate capture metadata as your job ledger.

Incomplete recordings may be salvageable, but require explicit review and separate
handling. Their timestamps/gaps cannot be inferred reliably from upload receive times.
