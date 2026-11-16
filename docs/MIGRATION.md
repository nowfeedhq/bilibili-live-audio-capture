# Migration and verification

## Audit and module boundaries

The inherited browser agent already implements explicit watch opt-in, room status
polling (0 offline / 1 LIVE / 2 loop), shadow-root player discovery, audio-only stream
capture, MIME negotiation, muting/restoration, ordered fragment retries, recorder
error handling and stop/finalize. Those mechanisms were retained, not replaced.

The previous HTTP endpoints shared a dashboard process with unrelated business
services. The capture store also required a specific disk layout. This distribution
extracts only capture storage and browser functionality; HTTP routing and deployment
are standalone. No original Git history, unrelated services, ASR worker, production
configuration, reports or captured data are included.

## Changed behavior

- Independent `X-Capture-Token` authentication; all endpoints protected, including health.
- User-configured server URL, HTTPS required except localhost; placeholder connect hostname.
- Standalone configurable output root; loopback listener; single spool owner lock.
- Manual capture room navigation now stops old recording, including navigation during start.
- Configuration changes refused while capture is active.
- Complete transport body read retained via a bounded iterator over **all** frames.
- SHA-256 verification during finalization, unexpected sequence checks, total disk/free-space
  limits, restart sealing and independent FFprobe/FFmpeg media validity.
- Responses omit absolute server storage paths; local workers read metadata directly.
- No automatic deletion, ASR dispatch, cloud publishing or NowFeed ingestion.

## Executed checks

Python 3.12 / aiohttp 3.14.4 and Node tests were executed in the migration environment.
Final result: 14 Python tests and 8 browser-script tests passed; zero failures.
Publication guard and manual file/identity-string review passed.
Tests cover authentication, complete-body transport framing (51,200 bytes delivered
in delayed fragments around 16 KiB), deduplication/conflicts, optional digest checks,
request limits, capacity, restart recovery, missing sequences, MIME matching and path
traversal. Synthetic WebM/Opus, Ogg/Opus and MP4/AAC are generated at test time, split,
uploaded, reassembled and decoded. Invalid bytes can be transport-complete and are
correctly reported as media-invalid.

Browser tests execute the actual userscript in a mocked DOM/MediaRecorder/GM environment:
explicit watch, offline/loop suppression, LIVE start, confirmed offline sealing, new
LIVE session, player wait/reload, room switching and manual no-player errors.
These are simulations, not a real Bilibili playback test. Firefox/Safari behavior,
current Bilibili player policies, background throttling and real continuous recordings
still require manual acceptance. Linux service and Caddy files were reviewed but not
installed on a production host. GitHub Actions have not run before publication.

## Publication

This package contains no `.git` directory and starts a fresh project. Publish using
an authorized brand maintainer account or installation whose public attribution is
acceptable. Initialize a new repository, inspect staged files and author/committer
metadata, then push main to the intended organization repository. Do not push from
a checkout containing private history. After publication verify README/raw userscript,
default branch and Actions results. No public commit or PR is part of this package.
