import WebSocket from "ws";
import { authTest, rtmConnect, getPresence } from "./slackClient.js";
import { log } from "./logger.js";

const PING_INTERVAL_MS = 30_000; // keep the socket lively (app + protocol ping)
const HEALTH_CHECK_MS = 15_000; // check for a dead/half-open socket
const STALE_MS = 75_000; // no traffic for this long → treat socket as dead
const MAX_CONNECTION_MS = 30 * 60_000; // proactively recycle before Slack drops us
const PRESENCE_CHECK_MS = 60_000; // observe our own presence (verification/telemetry)
const AWAY_RECONNECT_AFTER = 3; // presence가 이만큼 연속 away면 소켓이 제 역할을 못 하는 것 → 강제 재연결
const MAX_RECONNECT_MS = 60_000;

// 이 오류들은 재시도해도 소용없다(토큰/쿠키 만료·폐기). 재연결로 하염없이
// 두드리지 말고 "재인증 필요" 상태로 표시하고 멈춘다.
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "no_permission",
]);

// Owns ONE Slack connection: opens the RTM websocket, keeps it alive, DETECTS a
// dead socket (the failure mode that silently drops presence), and reconnects.
//
// 실측 교훈: 소켓은 ~2시간 뒤 조용히 죽는다(서버가 끊거나 half-open). 'close'
// 이벤트가 안 오는 경우가 있어, 트래픽 부재(heartbeat)로 죽음을 감지해야 한다.
// 또 Slack RTM URL은 시한부라 주기적 선제 재연결로 신선하게 유지한다.
export class PresenceKeeper {
  constructor(conn, onState) {
    this.conn = conn;
    this.onState = onState || (() => {});
    this.ws = null;
    this.msgId = 1;
    this.timers = {};
    this.reconnectDelay = 1000;
    this.running = false;
    this.slackUserId = null;
    this.lastActivityAt = 0; // 마지막으로 소켓에서 뭔가 받은 시각
    this.connectedAt = 0;
    this.consecutiveAway = 0; // presence가 연속으로 away인 횟수
    this.needsReauth = false; // 재인증 필요로 멈춤 → stop()이 상태를 덮지 않게
  }

  async start() {
    if (this.running) return;
    this.running = true;
    log(this.conn.id, "starting");
    await this.connect();
  }

  async stop() {
    this.running = false;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
    log(this.conn.id, "stopped");
    // needs_reauth 로 멈춘 연결은 status를 건드리지 않는다. 건드리면 다음 tick의
    // 정리(stop) 한 번으로 "재인증 필요"가 "일시정지"로 덮이고, 사용자는 대시보드에서
    // 재연결 안내를 못 본 채 error 문자열(invalid_auth)만 보게 된다.
    this.onState(
      this.conn.id,
      this.needsReauth ? { wsConnected: false } : { wsConnected: false, status: "paused" }
    );
  }

  async connect() {
    if (!this.running) return;
    const { xoxc, xoxd } = this.conn;
    try {
      if (!this.slackUserId) {
        const auth = await authTest(xoxc, xoxd);
        this.slackUserId = auth.user_id;
        log(this.conn.id, `auth ok — ${auth.user} (${auth.user_id}) @ ${auth.team}`);
      }
      const rtm = await rtmConnect(xoxc, xoxd);
      this.openSocket(rtm.url);
    } catch (err) {
      const reason = err.slackError || err.message;
      log(this.conn.id, `connect error: ${reason}`);
      if (AUTH_ERRORS.has(err.slackError)) {
        // 토큰 만료/폐기 — 재시도 무의미. "재인증 필요"로 표시하고 멈춘다.
        // (사용자가 확장으로 다시 연결하면 status=pending 으로 되살아난다.)
        log(this.conn.id, "→ 재인증 필요 (재연결 중단)");
        this.running = false;
        this.needsReauth = true;
        this.clearTimers();
        this.onState(this.conn.id, { status: "needs_reauth", wsConnected: false, error: reason });
        return;
      }
      this.onState(this.conn.id, { status: "error", error: reason });
      this.scheduleReconnect();
    }
  }

  openSocket(url) {
    const ws = new WebSocket(url, { headers: { Cookie: `d=${this.conn.xoxd}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1000; // reset backoff on a clean connect
      this.connectedAt = Date.now();
      this.lastActivityAt = Date.now();
      this.consecutiveAway = 0;
      log(this.conn.id, "websocket open → presence should be active");
      this.onState(this.conn.id, { wsConnected: true, status: "active", error: null });
      this.startPing();
      this.startHealthCheck();
      this.startPresenceCheck();
    });

    // 어떤 메시지든(=서버 응답, pong 포함) 받으면 살아있다는 신호.
    ws.on("message", () => {
      this.lastActivityAt = Date.now();
    });
    ws.on("pong", () => {
      this.lastActivityAt = Date.now();
    });

    ws.on("close", (code) => {
      log(this.conn.id, `websocket closed (code ${code})`);
      this.onState(this.conn.id, { wsConnected: false });
      this.clearTimer("ping");
      this.clearTimer("health");
      this.clearTimer("presence");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log(this.conn.id, `websocket error: ${err.message}`);
      // 'close' follows; reconnect handled there.
    });
  }

  startPing() {
    this.clearTimer("ping");
    this.timers.ping = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // 앱 레벨 RTM ping(활동 신호) + 프로토콜 ping(pong으로 생존 확인).
      try {
        this.ws.send(JSON.stringify({ id: this.msgId++, type: "ping" }));
        this.ws.ping();
      } catch (e) {
        log(this.conn.id, `ping failed: ${e.message}`);
      }
    }, PING_INTERVAL_MS);
  }

  // 죽은 소켓 감지 + 선제 재연결. 오늘 발견한 "2시간 뒤 영구 away"의 방어선.
  startHealthCheck() {
    this.clearTimer("health");
    this.timers.health = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - this.lastActivityAt > STALE_MS) {
        log(this.conn.id, `no traffic for ${Math.round((now - this.lastActivityAt) / 1000)}s → 소켓 죽음 판정, 재연결`);
        try { this.ws.terminate(); } catch {} // → 'close' → scheduleReconnect
        return;
      }
      if (now - this.connectedAt > MAX_CONNECTION_MS) {
        log(this.conn.id, "connection 오래됨 → 선제 재연결");
        try { this.ws.terminate(); } catch {}
      }
    }, HEALTH_CHECK_MS);
  }

  startPresenceCheck() {
    this.clearTimer("presence");
    const check = async () => {
      try {
        const p = await getPresence(this.conn.xoxc, this.conn.xoxd, this.slackUserId);
        log(this.conn.id, `presence = ${p.presence}`);
        this.onState(this.conn.id, {
          lastPresence: p.presence,
          ...(p.presence === "active" ? { lastSeenActiveAt: Date.now() } : {}),
        });

        // 소켓은 열려 있는데 presence가 계속 away면, 이 소켓이 제 역할을 못 하는
        // 것 → 강제 재연결로 신선한 소켓을 얻는다. (13h 로그의 "away 사막" 대응)
        if (this.ws?.readyState === WebSocket.OPEN) {
          if (p.presence === "active") {
            this.consecutiveAway = 0;
          } else if (++this.consecutiveAway >= AWAY_RECONNECT_AFTER) {
            log(this.conn.id, `presence ${this.consecutiveAway}회 연속 away → 강제 재연결`);
            this.consecutiveAway = 0;
            try { this.ws.terminate(); } catch {}
          }
        }
      } catch (e) {
        log(this.conn.id, `getPresence failed: ${e.slackError || e.message}`);
      }
    };
    check();
    this.timers.presence = setInterval(check, PRESENCE_CHECK_MS);
  }

  scheduleReconnect() {
    if (!this.running) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    log(this.conn.id, `reconnecting in ${delay}ms`);
    this.clearTimer("reconnect");
    this.timers.reconnect = setTimeout(() => this.connect(), delay);
  }

  clearTimer(name) {
    const t = this.timers[name];
    if (t) {
      clearInterval(t);
      clearTimeout(t);
      delete this.timers[name];
    }
  }

  clearTimers() {
    for (const name of Object.keys(this.timers)) this.clearTimer(name);
  }
}
