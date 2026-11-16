# Installation

## Local setup

Install Python 3.11+, python3-venv and FFmpeg (including FFprobe) from your Linux
package manager. From the project directory run the README quick start commands.
Configuration generation refuses to overwrite a file and creates it with mode 0600.
The example has no working token; server startup refuses a token shorter than 40
characters. Never commit the generated config. Use a separate token for this service.

`output_root` is resolved relative to the process working directory. Store it on a
trusted local filesystem owned exclusively by the service user. Defaults: 2 MiB per
fragment, 1 GiB per session, 10 GiB total spool, 512 MiB minimum free space.
Both raw chunks and assembled files count against the spool limit. Metadata has
some overhead; limits are operational guards, not a filesystem quota. Set a filesystem
quota for a strict disk ceiling. There is no retention daemon or automatic deletion.
Archive sealed sessions externally, verify them, then delete only those session folders.

## Dedicated service (example; review paths first)

```sh
sudo useradd --system --home /opt/nowfeed-capture --shell /usr/sbin/nologin nowfeed-capture
sudo mkdir -p /opt/nowfeed-capture /var/lib/nowfeed-capture
sudo cp -R . /opt/nowfeed-capture/
sudo chown -R nowfeed-capture:nowfeed-capture /opt/nowfeed-capture /var/lib/nowfeed-capture
sudo -u nowfeed-capture sh -c 'cd /opt/nowfeed-capture && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python server/generate_config.py'
```

Set `output_root` in `/opt/nowfeed-capture/server/config.json` to
`/var/lib/nowfeed-capture`. Copy `deploy/nowfeed-capture.service` to
`/etc/systemd/system/`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now nowfeed-capture
sudo systemctl status nowfeed-capture
sudo journalctl -u nowfeed-capture -f
```

These are instructions for a **new deployment**, never an instruction to replace
an existing service. Application request logs are disabled to avoid logging tokens
or room identifiers. Startup/errors are available in the journal; per-session events
are in `sessions/<id>/events.jsonl`. Protect logs and spool as private content.

## HTTPS

Use the Caddy example with your own domain and certificate configuration. Apply it
only to your own new deployment. Keep the Python listener on loopback; expose only
HTTPS. Do not log the `X-Capture-Token` header at the proxy. No CORS allowance is
needed: Tampermonkey uses privileged `GM_xmlhttpRequest` with no cookies.

## Tampermonkey

Create a new script in Tampermonkey and paste the delivered `.user.js` file (or open
the raw file after publication). Replace `@connect capture.example.com` with your
server hostname. Save and accept the permission prompt. In a numeric Bilibili live
room, open the script settings, enter `https://capture.example.com` replaced with
your endpoint, and paste the generated config's token. Tokens stay in Tampermonkey
storage; never put them in URLs. HTTP is allowed only for localhost development.

Start playback first. Manual capture mutes the player and restores its previous
mute/volume state on stop. Watch must be explicitly enabled. Browser background
throttling, sleep, autoplay policy, player updates and captureStream restrictions can
interrupt recording. Stop and seal before navigating or closing the browser.

## Troubleshooting

- 401: compare the dedicated token; no ASR or other service token is accepted.
- Connection failure: check HTTPS, hostname permission (`@connect`), proxy and service.
- No player/audio track: start playback; use a browser supporting captureStream and
  an audio-only MediaRecorder MIME. Try a foreground Chromium tab first.
- 413: fragment exceeds configured size (sleep can enlarge recorder fragments).
- 507: spool/session limit or minimum free space reached; archive data or increase
  reviewed limits. Do not delete fragments from an active session.
- incomplete: inspect missing/corrupt/unexpected sequences and session events.
- completed + invalid: transport succeeded but audio is not decodable; do not enqueue ASR.
- validation_failed: FFmpeg timeout or tool failure. Validate the assembled file offline.
- Service won't start: inspect JSON/token, permissions and single-process spool lock.
  After an abnormal termination, restart seals previous recording sessions incomplete.
  If capacity prevents recovery assembly, free/archive space before retrying startup.
