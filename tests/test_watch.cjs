const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = fs.readFileSync(
  path.resolve(__dirname, "../userscript/bilibili-live-audio-capture.user.js"), "utf8"
);

function createHarness() {
  let liveStatus = 0;
  let playerReady = true;
  let trackReady = true;
  let failures = 0;
  let sessionNumber = 0;
  let starts = 0;
  let finishes = 0;
  let uploads = 0;
  let reloads = 0;
  const intervals = [];
  const store = new Map();
  const controls = new Map();

  function element(id) {
    if (!controls.has(id)) {
      const handlers = new Map();
      controls.set(id, {
        style: {}, textContent: "", disabled: false,
        addEventListener(type, handler) { handlers.set(type, handler); },
        click() { handlers.get("click")?.(); }
      });
    }
    return controls.get(id);
  }
  const shadow = {innerHTML: "", getElementById: element};
  const audioTrack = {
    readyState: "live",
    addEventListener() {},
    stop() {}
  };
  const player = {
    isConnected: true,
    paused: false,
    readyState: 4,
    muted: false,
    volume: 1,
    getBoundingClientRect() { return {width: 360, height: 200}; },
    captureStream() { return {getAudioTracks() { return trackReady ? [audioTrack] : []; }, getTracks() { return [audioTrack]; }}; }
  };

  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }

  class FakeMediaRecorder {
    constructor() {
      this.state = "inactive";
      this.mimeType = "audio/webm;codecs=opus";
      this.listeners = new Map();
    }
    static isTypeSupported() { return true; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.listeners.get("dataavailable")?.({data: {size: 240000, type: this.mimeType}});
      this.listeners.get("stop")?.();
    }
  }

  const document = {
    getElementById() { return null; },
    createElement() {
      return {style: {}, attachShadow() { return shadow; }};
    },
    documentElement: {appendChild() {}},
    querySelectorAll(query) {
      if (query === "video, audio") return playerReady ? [player] : [];
      return [];
    },
    title: "NowFeed watch mode test"
  };

  const context = {
    document,
    window: {addEventListener() {}},
    location: {pathname: "/123456", reload() { reloads++; }},
    navigator: {userAgent: "test"},
    sessionStorage: {
      getItem(key) { return store.get(key) ?? null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); }
    },
    HTMLMediaElement: {HAVE_CURRENT_DATA: 2},
    MediaStream: FakeMediaStream,
    MediaRecorder: FakeMediaRecorder,
    GM_getValue(key, fallback) {
      return key === "browser_capture_token" ? "test-token-with-plenty-of-length-xxxxxxxxxxxxxxxxxxxx" : fallback;
    },
    GM_setValue() {},
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      if (options.url.includes("room/v1/Room/room_init")) {
        options.onload({status: 200, responseText: JSON.stringify({
          code: 0, data: {live_status: liveStatus}
        })});
      } else if (options.url.endsWith("/api/browser-capture/start")) {
        starts++;
        options.onload({status: 201, responseText: JSON.stringify({session_id: "session-" + (++sessionNumber)})});
      } else if (/\/chunk\/\d+$/.test(options.url)) {
        if (failures > 0) { failures--; options.onload({status:503,responseText:"unavailable"}); return; }
        uploads++;
        options.onload({status: 200, responseText: JSON.stringify({bytes_received: 240000})});
      } else if (options.url.endsWith("/finish")) {
        finishes++;
        options.onload({status: 200, responseText: JSON.stringify({
          status: "completed", chunks_received: uploads, assembled_bytes: 240000
        })});
      } else {
        throw new Error("Unexpected request: " + options.url);
      }
    },
    setInterval(callback, interval) { intervals.push({callback, interval}); },
    setTimeout,
    URL,
    Date,
    prompt() { return null; },
    alert() {}
  };

  vm.runInNewContext(SCRIPT, context);
  const watchInterval = intervals.find(x => x.interval === 12000);
  assert.ok(watchInterval, "watch-live poll interval registered");
  return {
    setTrackReady(v) { trackReady = v; },
    failUploads(n) { failures = n; },
    setLive(v) { liveStatus = v; },
    setPlayerReady(v) { playerReady = v; },
    click(id) { element(id).click(); },
    async tick() { await watchInterval.callback(); await new Promise(resolve => setImmediate(resolve)); },
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    get starts() { return starts; },
    get finishes() { return finishes; },
    get uploads() { return uploads; },
    get reloads() { return reloads; },
    async safetyTick() { await intervals.find(x => x.interval === 5000).callback(); await new Promise(resolve => setImmediate(resolve)); },
    setRoom(value) { context.location.pathname = "/" + value; },
    get savedRoom() { return store.get("nowfeed_browser_watch_room"); },
    get status() { return element("status").textContent; },
    get watchText() { return element("watch").textContent; }
  };
}

test("offline and looping rooms do not create capture sessions; LIVE starts exactly once", async () => {
  const h = createHarness();
  h.click("watch");
  await h.flush();
  assert.equal(h.starts, 0);
  assert.equal(h.savedRoom, "123456");

  h.setLive(2);
  await h.tick();
  assert.equal(h.starts, 0);

  h.setLive(1);
  await h.tick();
  assert.equal(h.starts, 1);
  await h.tick();
  assert.equal(h.starts, 1, "avoid duplicate sessions during active recording");
  assert.match(h.watchText, /停止蹲播/);

  h.click("stop");
  await h.flush();
  assert.equal(h.finishes, 1);
  assert.equal(h.uploads, 1);
  assert.equal(h.savedRoom, undefined, "manual stop disarms watch");
  await h.tick();
  assert.equal(h.starts, 1, "do not silently auto-restart after manual stop");
});

test("confirmed offline stops the current segment and later live status resumes", async () => {
  const h = createHarness();
  h.setLive(1);
  h.click("watch");
  await h.flush();
  assert.equal(h.starts, 1);

  h.setLive(0);
  await h.tick();
  await h.tick();
  assert.equal(h.finishes, 0, "offline signal must be confirmed");
  await h.tick();
  assert.equal(h.finishes, 1);

  h.setLive(1);
  await h.tick();
  assert.equal(h.starts, 2, "returning LIVE starts a new recording session");

  h.click("watch");
  await h.flush();
  assert.equal(h.finishes, 2, "disarming active watch finalizes current session");
});

test("live status without a ready player refreshes in this tab, not a fake capture", async () => {
  const h = createHarness();
  h.setLive(1);
  h.setPlayerReady(false);
  h.click("watch");
  await h.flush();
  await h.tick();
  await h.tick();
  assert.equal(h.starts, 0);
  assert.equal(h.reloads, 1);
  assert.equal(h.savedRoom, "123456");
  await h.tick();
  assert.equal(h.reloads, 1, "reload cooldown prevents a loop");
});

test("switching rooms disarms watch and finalizes the old recording", async () => {
  const h = createHarness();
  h.setLive(1);
  h.click("watch");
  await h.flush();
  assert.equal(h.starts, 1);
  h.setRoom("654321");
  await h.tick();
  assert.equal(h.finishes, 1);
  assert.equal(h.savedRoom, undefined);
  assert.match(h.status, /直播间已切换/);
  await h.tick();
  assert.equal(h.starts, 1);
});


test("manual capture stops on room navigation", async () => {
 const h = createHarness(); h.click("start"); await h.flush();
 assert.equal(h.starts, 1); h.setRoom("654321"); await h.safetyTick(); await h.flush();
 assert.equal(h.finishes, 1);
});
test("manual capture reports missing player", async () => {
 const h = createHarness(); h.setPlayerReady(false); h.click("start"); await h.flush();
 assert.equal(h.starts, 0); assert.match(h.status, /没有找到/);
});

test("missing audio track is an explicit startup error", async () => {
 const h=createHarness(); h.setTrackReady(false); h.click("start"); await h.flush();
 assert.equal(h.starts,0); assert.match(h.status,/音轨/);
});
test("transient fragment upload retries before sealing", async () => {
 const h=createHarness(); h.click("start"); await h.flush(); h.failUploads(1);
 h.click("stop"); await new Promise(resolve=>setTimeout(resolve,1150)); await h.flush();
 assert.equal(h.uploads,1); assert.equal(h.finishes,1);
});
