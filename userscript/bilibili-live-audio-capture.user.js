// ==UserScript==
// @name         NowFeed · Bilibili Browser Audio Capture
// @namespace    https://github.com/nowfeedhq/
// @version      0.3.0
// @description  Explicitly capture audio-only from the current Bilibili live player and upload chunks to NowFeed Capture
// @match        https://live.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      capture.example.com
// @connect      api.live.bilibili.com
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_SERVER = "https://capture.example.com";
  const CHUNK_MS = 15000;
  const WATCH_POLL_MS = 12000;
  const WATCH_ROOM_KEY = "nowfeed_browser_watch_room";
  const WATCH_RELOAD_KEY = "nowfeed_browser_watch_last_reload";
  const WATCH_RELOAD_COOLDOWN_MS = 120000;
  const OFFLINE_CONFIRMATIONS = 3;
  const MAX_STATUS_ERRORS_WHILE_RECORDING = 20;
  const MAX_RETRIES = 3;
  const PANEL_ID = "nowfeed-browser-capture-panel";

  let recorder = null;
  let sourceStream = null;
  let audioStream = null;
  let mediaElement = null;
  let originalMuteState = null;
  let sessionId = null;
  let recordingRoom = "";
  let recordingMimeType = "";
  let nextSequence = 1;
  let uploadChain = Promise.resolve();
  let uploadFailure = null;
  let uploadedBytes = 0;
  let uploadedChunks = 0;
  let stopping = false;
  let panelShadow = null;
  let starting = false;
  let watchEnabled = false;
  let watchRoom = "";
  let watchChecking = false;
  let offlineChecks = 0;
  let watchApiErrors = 0;
  let missingPlayerChecks = 0;
  let nextWatchStartAt = 0;

  function roomIdFromUrl() {
    const match = location.pathname.match(/^\/(\d{1,12})(?:\/|$)/);
    return match ? match[1] : "";
  }

  function serverBase() {
    return String(GM_getValue("server_base", DEFAULT_SERVER)).trim().replace(/\/+$/, "");
  }

  function token() {
    return String(GM_getValue("browser_capture_token", "")).trim();
  }

  function request(path, method = "GET", data = null, headers = {}) {
    const secret = token();
    if (!secret) return Promise.reject(new Error("请先在油猴菜单中设置 Browser Capture Token"));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: serverBase() + path,
        headers: {
          "X-Capture-Token": secret,
          "Accept": "application/json",
          ...headers
        },
        data,
        timeout: 20000,
        anonymous: true,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error("NowFeed Capture HTTP " + response.status + ": " + String(response.responseText || "").slice(0, 180)));
            return;
          }
          if (response.responseText) {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (_) {
              reject(new Error("服务器返回了无法解析的响应"));
            }
          } else {
            resolve({});
          }
        },
        onerror: () => reject(new Error("NowFeed Capture 网络连接失败")),
        ontimeout: () => reject(new Error("NowFeed Capture 请求超时"))
      });
    });
  }

  function roomIsLive(room) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: "https://api.live.bilibili.com/room/v1/Room/room_init?id=" +
          encodeURIComponent(room) + "&_=" + Date.now(),
        headers: {"Accept": "application/json"},
        timeout: 10000,
        anonymous: true,
        onload: response => {
          if (response.status !== 200) return reject(new Error("Bilibili HTTP " + response.status));
          try {
            const payload = JSON.parse(response.responseText);
            const liveStatus = Number(payload?.data?.live_status);
            if (payload.code !== 0 || ![0, 1, 2].includes(liveStatus)) {
              throw new Error("直播状态响应不可用");
            }
            resolve(liveStatus === 1);
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Bilibili 状态接口网络异常")),
        ontimeout: () => reject(new Error("Bilibili 状态查询超时"))
      });
    });
  }

  function disarmWatch() {
    watchEnabled = false;
    watchRoom = "";
    offlineChecks = 0;
    missingPlayerChecks = 0;
    sessionStorage.removeItem(WATCH_ROOM_KEY);
    refreshPanel();
  }

  async function watchTick() {
    if (!watchEnabled || watchChecking) return;
    const room = roomIdFromUrl();
    if (!room || room !== watchRoom) {
      disarmWatch();
      if (recorder && !stopping) await stopCapture("room_changed");
      setStatus("直播间已切换，已停止蹲播和旧房间录音以防误录。", "error");
      return;
    }

    watchChecking = true;
    try {
      const live = await roomIsLive(room);
      if (!watchEnabled || room !== watchRoom) return;
      if (roomIdFromUrl() !== room) {
        disarmWatch();
        if (recorder && !stopping) await stopCapture("room_changed");
        setStatus("房间在状态检查期间发生切换；已终止旧录音。", "error");
        return;
      }
      watchApiErrors = 0;

      if (!live) {
        offlineChecks++;
        missingPlayerChecks = 0;
        if (recorder && offlineChecks >= OFFLINE_CONFIRMATIONS && !stopping) {
          await stopCapture("live_ended");
        } else if (!recorder && !starting && !stopping) {
          setStatus("蹲播中 · 尚未开播（轮播不录）；自动继续检查。");
        }
        return;
      }

      offlineChecks = 0;
      if (recorder || starting || stopping || Date.now() < nextWatchStartAt) return;
      if (findPlayer()) {
        missingPlayerChecks = 0;
        const started = await startCapture("watch");
        if (!started) nextWatchStartAt = Date.now() + 30000;
      } else {
        missingPlayerChecks++;
        setStatus("检测到 LIVE，等待实际播放器就绪…");
        if (missingPlayerChecks >= 3) {
          const previousReload = Number(sessionStorage.getItem(WATCH_RELOAD_KEY) || "0");
          if (Date.now() - previousReload >= WATCH_RELOAD_COOLDOWN_MS) {
            sessionStorage.setItem(WATCH_RELOAD_KEY, String(Date.now()));
            setStatus("直播已开但播放器未加载，刷新页面重试。");
            location.reload();
          }
        }
      }
    } catch (error) {
      if (watchEnabled) {
        watchApiErrors++;
        if (recorder && watchApiErrors >= MAX_STATUS_ERRORS_WHILE_RECORDING && !stopping) {
          await stopCapture("status_unavailable");
          setStatus("连续无法确认开播状态，录音已按 incomplete 封存；蹲播继续重试。", "error");
        } else {
          setStatus("蹲播状态查询失败：" + error.message + "；自动重试。", "error");
        }
      }
    } finally {
      watchChecking = false;
      refreshPanel();
    }
  }

  function toggleWatch() {
    if (watchEnabled) {
      disarmWatch();
      if (recorder) stopCapture("user");
      else setStatus("已关闭蹲播。");
      return;
    }
    const room = roomIdFromUrl();
    if (!room || !token()) {
      setStatus("开启蹲播前，请进入数字直播间并设置 Browser Capture Token。", "error");
      return;
    }
    watchEnabled = true;
    watchRoom = room;
    offlineChecks = 0;
    watchApiErrors = 0;
    missingPlayerChecks = 0;
    nextWatchStartAt = 0;
    sessionStorage.setItem(WATCH_ROOM_KEY, room);
    setStatus("已开启蹲播，LIVE 且播放器就绪才开始录音。");
    watchTick();
  }

  function allMediaElements() {
    const found = new Set();
    function scan(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll("video, audio").forEach(el => found.add(el));
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    }
    scan(document);
    return [...found];
  }

  function findPlayer() {
    const candidates = allMediaElements()
      .filter(el => typeof el.captureStream === "function" || typeof el.mozCaptureStream === "function")
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {el, visible: rect.width > 80 && rect.height > 45, area: rect.width * rect.height};
      })
      .filter(x => x.visible && x.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !x.el.paused)
      .sort((a, b) => b.area - a.area);
    return candidates[0]?.el || null;
  }

  function recorderMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    throw new Error("当前浏览器没有可用的音频 MediaRecorder 编码格式");
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647";
    const shadow = host.attachShadow({mode: "open"});
    shadow.innerHTML = [
      "<style>",
      ":host{all:initial}.panel{width:300px;background:#151a20;color:#edf2f7;border:1px solid #394552;border-radius:13px;padding:13px 14px;box-shadow:0 8px 32px #0008;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
      ".head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:750}.tag{font-size:10px;color:#9db3c5;letter-spacing:.08em}",
      ".status{margin:9px 0;color:#c8d2db;min-height:38px;overflow-wrap:anywhere}.meta{color:#9aabb8;font-size:11px;margin:5px 0}",
      ".actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;border-radius:8px;padding:8px 11px;font-weight:700;cursor:pointer}",
      "button:disabled{opacity:.4;cursor:not-allowed}#start{background:#83d6a2;color:#10231a;flex:1}#stop{background:#e3a0a0;color:#321616;flex:1}#watch{background:#a0baf5;color:#101b30;flex:1;min-width:110px}#settings{background:#344250;color:#e7edf2}",
      ".hint{font-size:10px;color:#8294a1;margin-top:9px}",
      "</style>",
      "<div class='panel'><div class='head'><span>NowFeed Capture · Browser Capture</span><span class='tag'>AUDIO ONLY</span></div>",
      "<div id='status' class='status'>等待播放器就绪</div><div id='room' class='meta'></div><div id='stats' class='meta'>尚未开始</div>",
      "<div class='actions'><button id='start'>手动采集</button><button id='stop' disabled>停止并封存</button><button id='watch'>开启蹲播</button><button id='settings' title='设置服务器和 Token'>⚙</button></div>",
      "<div class='hint'>蹲播必须手动开启，只对本标签页当前房间有效；保持电脑、网络和直播页运行。停止蹲播会封存当前录音。</div></div>"
    ].join("");
    panelShadow = shadow;
    shadow.getElementById("start").addEventListener("click", () => {
      if (watchEnabled) disarmWatch();
      startCapture("manual");
    });
    shadow.getElementById("stop").addEventListener("click", () => {
      if (watchEnabled) disarmWatch();
      stopCapture("user");
    });
    shadow.getElementById("watch").addEventListener("click", toggleWatch);
    shadow.getElementById("settings").addEventListener("click", configure);
    document.documentElement.appendChild(host);
    refreshPanel();
  }

  function setStatus(message, level = "info") {
    const p = panelShadow;
    if (!p) return;
    const el = p.getElementById("status");
    el.textContent = message;
    el.style.color = level === "error" ? "#ff9f9f" : level === "success" ? "#8ce0a8" : "#c8d2db";
    refreshPanel();
  }

  function refreshPanel() {
    const p = panelShadow;
    if (!p) return;
    const room = roomIdFromUrl();
    p.getElementById("room").textContent = room ? "Room ID: " + room : "未能从当前 URL 识别数字房间号";
    p.getElementById("stats").textContent = sessionId
      ? "Session " + sessionId + " · " + uploadedChunks + " chunks · " + (uploadedBytes / 1024).toFixed(1) + " KiB"
      : "服务器：" + (serverBase() || "未设置");
    p.getElementById("start").disabled = Boolean(recorder || starting || stopping || !room);
    p.getElementById("stop").disabled = !recorder && !stopping;
    p.getElementById("watch").disabled = !watchEnabled && !room;
    p.getElementById("watch").textContent = watchEnabled ? "停止蹲播" : "开启蹲播";
  }

  function configure() {
    if (recorder || starting || stopping) { alert("请先停止并封存录音再修改配置。"); return; }
    const nextServer = prompt("NowFeed Capture Server Base URL", serverBase());
    if (nextServer === null) return;
    let parsed;
    try {
      parsed = new URL(nextServer.trim());
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) throw new Error();
      if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    } catch (_) {
      alert("服务器地址无效。");
      return;
    }
    GM_setValue("server_base", nextServer.trim().replace(/\/+$/, ""));
    const nextToken = prompt("粘贴服务器 generate_config.py 输出的专用 Token", token());
    if (nextToken === null) {
      refreshPanel();
      return;
    }
    if (nextToken.trim().length < 40) {
      alert("Token 长度不足，未保存。");
      return;
    }
    GM_setValue("browser_capture_token", nextToken.trim());
    setStatus("服务器地址和专用 Token 已保存在 Tampermonkey。", "success");
  }

  async function retryUpload(path, blob, mime) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await request(path, "POST", blob, {
          "Content-Type": "application/octet-stream",
          "X-Capture-Mime": mime
        });
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError || new Error("音频分片上传失败");
  }

  function queueChunk(blob) {
    if (!blob || blob.size === 0) return;
    const sequence = nextSequence++;
    uploadChain = uploadChain.then(async () => {
      const path = "/api/browser-capture/" + encodeURIComponent(sessionId) + "/chunk/" + sequence;
      const result = await retryUpload(path, blob, recordingMimeType || blob.type);
      uploadedBytes += blob.size;
      uploadedChunks++;
      setStatus("采集中 · 最近上传 #" + sequence + " · 服务端累计 " + (result.bytes_received / 1024).toFixed(1) + " KiB", "success");
    }).catch(error => {
      if (!uploadFailure) uploadFailure = error;
      setStatus("分片 #" + sequence + " 上传失败：" + error.message, "error");
      if (recorder && recorder.state !== "inactive") stopCapture("upload_error");
    });
  }

  async function startCapture(mode = "manual") {
    if (recorder || starting || stopping) return false;
    starting = true;
    try {
    const roomId = roomIdFromUrl();
    if (!roomId) {
      setStatus("请打开数字房间号形式的 Bilibili 直播间 URL。", "error");
      return;
    }
    if (!token()) {
      setStatus("请先点击齿轮设置服务器地址和专用 Token。", "error");
      return;
    }
    const player = findPlayer();
    if (!player) {
      setStatus("没有找到正在播放的直播媒体元素。请先手动播放直播，再点开始。", "error");
      return;
    }
    const capture = player.captureStream || player.mozCaptureStream;
    if (typeof capture !== "function") {
      setStatus("当前浏览器不支持 HTMLMediaElement.captureStream()。", "error");
      return;
    }

    let stream = null;
    let createdSessionId = null;
    try {
      stream = capture.call(player);
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw new Error("播放器没有暴露可捕获的音轨；可能尚未开始播放或音轨受浏览器限制。");

      const mime = recorderMimeType();
      const onlyAudio = new MediaStream(tracks);
      const mediaRecorder = new MediaRecorder(onlyAudio, {mimeType: mime});
      originalMuteState = {video: player, muted: player.muted, volume: player.volume};
      player.muted = true;
      player.volume = 0;

      const started = await request("/api/browser-capture/start", "POST", JSON.stringify({
        room_id: roomId,
        room_url: "https://live.bilibili.com/" + roomId,
        title: document.title,
        browser: navigator.userAgent,
        mime_type: mediaRecorder.mimeType || mime,
        audio_tracks: tracks.length,
        player_muted: true
      }), {"Content-Type": "application/json"});

      createdSessionId = started.session_id;
      sessionId = createdSessionId;
      recordingRoom = roomId;
      recorder = mediaRecorder;
      sourceStream = stream;
      audioStream = onlyAudio;
      mediaElement = player;
      recordingMimeType = mediaRecorder.mimeType || mime;
      nextSequence = 1;
      uploadChain = Promise.resolve();
      uploadFailure = null;
      uploadedBytes = 0;
      uploadedChunks = 0;
      stopping = false;

      recorder.addEventListener("dataavailable", event => queueChunk(event.data));
      recorder.addEventListener("error", event => {
        if (!uploadFailure) uploadFailure = event.error || new Error("MediaRecorder error");
        setStatus("浏览器录音器发生错误：" + uploadFailure.message, "error");
        stopCapture("recorder_error");
      });
      tracks.forEach(track => {
        track.addEventListener("ended", () => {
          if (recorder && recorder.state !== "inactive") stopCapture("audio_track_ended");
        }, {once: true});
      });

      if (roomIdFromUrl() !== roomId) throw new Error("直播间已切换");
      if (mode === "watch" && (!watchEnabled || watchRoom !== roomId || roomIdFromUrl() !== roomId)) {
        throw new Error("蹲播已取消或已切换房间");
      }
      recorder.start(CHUNK_MS);
      setStatus("已开始静音音轨采集。每 15 秒上传一个分片。", "success");
      refreshPanel();
    } catch (error) {
      if (createdSessionId) {
        try {
          await request("/api/browser-capture/" + encodeURIComponent(createdSessionId) + "/finish",
            "POST", JSON.stringify({complete: false, final_sequence: 0, reason: "recorder_start_failed"}),
            {"Content-Type": "application/json"});
        } catch (_) {}
      }
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); } catch (_) {}
      }
      recorder = null;
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (originalMuteState) restorePlayerAudio();
      sessionId = null;
      recordingMimeType = "";
      refreshPanel();
      setStatus("启动失败：" + error.message, "error");
    }
    return Boolean(recorder);
    } finally {
      starting = false;
      refreshPanel();
    }
  }

  function restorePlayerAudio() {
    if (!originalMuteState) return;
    const {video, muted, volume} = originalMuteState;
    try {
      if (video.isConnected) {
        video.muted = muted;
        video.volume = volume;
      }
    } catch (_) {}
    originalMuteState = null;
  }

  async function stopCapture(reason = "user") {
    if (stopping || !recorder) return;
    stopping = true;
    const activeRecorder = recorder;
    recorder = null;
    setStatus("正在停止录音并等待最后分片上传…");
    try {
      if (activeRecorder.state !== "inactive") {
        const stopped = new Promise(resolve => activeRecorder.addEventListener("stop", resolve, {once: true}));
        activeRecorder.stop();
        await stopped;
      }
      await uploadChain;
      const result = await request(
        "/api/browser-capture/" + encodeURIComponent(sessionId) + "/finish",
        "POST",
        JSON.stringify({
          complete: !uploadFailure && ["user", "live_ended", "player_removed",
            "audio_track_ended", "audio_track_unavailable"].includes(reason),
          final_sequence: nextSequence - 1,
          reason
        }),
        {"Content-Type": "application/json"}
      );
      setStatus(
        "已封存：" + result.status + " · " + result.chunks_received +
        " chunks · " + (result.assembled_bytes / 1024).toFixed(1) + " KiB",
        result.status === "completed" ? "success" : "error"
      );
    } catch (error) {
      setStatus("停止/封存失败：" + error.message + "。请保留服务器分片，不要删除。", "error");
    } finally {
      if (sourceStream) sourceStream.getTracks().forEach(track => track.stop());
      if (audioStream) audioStream.getTracks().forEach(track => track.stop());
      sourceStream = null;
      audioStream = null;
      mediaElement = null;
      restorePlayerAudio();
      sessionId = null;
      recordingMimeType = "";
      stopping = false;
      refreshPanel();
    }
  }

  GM_registerMenuCommand("NowFeed Browser Capture · 设置服务器和 Token", configure);
  GM_registerMenuCommand("NowFeed Browser Capture · 显示当前配置", () => {
    alert("Server: " + serverBase() + "\nToken: " + (token() ? "已设置（不会显示）" : "未设置"));
  });

  createPanel();
  // Restore explicit opt-in only after reload in this same room/tab.
  const savedRoom = sessionStorage.getItem(WATCH_ROOM_KEY);
  if (savedRoom && savedRoom === roomIdFromUrl() && token()) {
    watchEnabled = true;
    watchRoom = savedRoom;
    setStatus("已恢复本标签页蹲播，继续检查开播状态。");
    watchTick();
  }
  setInterval(watchTick, WATCH_POLL_MS);
  setInterval(() => {
    if (!recorder || !mediaElement) return;
    if (roomIdFromUrl() !== recordingRoom) {
      disarmWatch();
      stopCapture("room_changed");
      return;
    }
    if (!mediaElement.isConnected) {
      stopCapture("player_removed");
      return;
    }
    const tracks = audioStream ? audioStream.getAudioTracks() : [];
    if (!tracks.length || tracks.every(track => track.readyState === "ended")) {
      stopCapture("audio_track_unavailable");
    }
  }, 5000);

  window.addEventListener("beforeunload", event => {
    if ((recorder && recorder.state !== "inactive") || stopping) {
      event.preventDefault();
      event.returnValue = "NowFeed Browser Capture is still recording. Stop and finalize before leaving.";
      return event.returnValue;
    }
    return undefined;
  });
})();
