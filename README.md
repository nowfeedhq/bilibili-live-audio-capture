# Bilibili Live Audio Capture

An open-source audio capture agent for Bilibili Live, by NowFeed.

**Let your bot watch the streams you care about. Read the highlights instead.**

Capture audio from the player in your own browser with Tampermonkey. A standalone,
token-authenticated Python server stores, checks and seals recording sessions.
No dashboard, ASR worker, private network or other business service is required.

Future use case: subscribe to a creator, capture their livestream audio, transcribe
it with an external ASR system, and read a concise summary instead of watching the
full stream. External ASR and NowFeed integration are future work, not included features.

## Quick start

Linux, Python 3.11+ (tested on 3.12), Node 20+ for script tests, FFmpeg and FFprobe.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server/generate_config.py
.venv/bin/python -m server.app --config server/config.json
```

The server binds to **127.0.0.1:8765** by default. Keep it private; configure HTTPS
before remote use. See [installation](docs/INSTALLATION.md) for systemd, HTTPS,
Tampermonkey setup, token handling and troubleshooting.

Install [the userscript](userscript/bilibili-live-audio-capture.user.js) in
Tampermonkey. Set your HTTPS endpoint and dedicated token via its settings menu.
Change its `@connect capture.example.com` to your own hostname. Open a numeric
Bilibili room URL, play the stream, then choose manual capture or explicitly enable
watch mode (蹲播). Stop and seal before closing the tab.

## Behavior and boundaries

- Audio-only `HTMLMediaElement.captureStream()` → `MediaRecorder` → 15-second
  fragments; serialized uploads with three attempts per fragment.
- Watch mode polls every 12 seconds; offline/looping does not create a session.
  Three consecutive offline results seal a recording; LIVE permits a new session.
  Manual stop disarms watch. Explicit opt-in survives reload in the same tab/room.
- Browser and computer must remain running. This is not a headless recorder or
  cloud multi-room monitoring service. No transcription or automatic summaries.
- Recorder fragments belong to one continuous stream, not separate playable files.
  Byte concatenation preserves WebM/Ogg/fragmented MP4; unsupported browser variants
  may still fail decoding. Check `media_validity`, not just `completed`.
- Browser upload queue is memory-only. Closing/crashing the tab can lose pending
  fragments. Unsealed sessions remain recording until server restart, which seals
  them incomplete. No promise of recovery of browser-only data.
- Single server process per spool; local disk only. Disk limits stop writes; there
  is no automatic deletion. Reserve room for raw fragments **and** assembled media.
- Capture only content you are authorized to record; deployment remains user-controlled.

## Verification

```sh
python -m unittest discover -s tests -v
node --test tests/test_watch.cjs
```

See [API](docs/API.md), [external ASR integration](docs/ASR_INTEGRATION.md),
[migration and verification notes](docs/MIGRATION.md), and [security](SECURITY.md).

MIT License. Copyright (c) 2026 NowFeed contributors.
