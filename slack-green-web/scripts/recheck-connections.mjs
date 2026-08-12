// 실패 상태(needs_reauth / error)로 남은 연결을 다시 검증한다.
//
//   node scripts/recheck-connections.mjs          # 조회만 (dry-run)
//   node scripts/recheck-connections.mjs --apply  # 살아있는 건 pending으로 되살림
//
// 서버가 사용자를 "대신 재연결"할 수는 없다 — xoxc/xoxd는 그 사용자 브라우저
// 세션에만 있고 서버는 재발급 수단이 없다. 여기서 할 수 있는 건 두 가지:
//   1) 저장된 자격증명이 아직 유효하면 되살린다 (일시적 오류 / xoxd 인코딩 문제).
//   2) 진짜 만료된 사용자 목록(이메일)을 뽑아 재연결을 안내한다.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// .env 로드 (Node 18은 --env-file 미지원)
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// src/lib/crypto.js 와 같은 방식(AES-256-GCM). 그 파일은 CJS 패키지 안의 ESM
// 소스라 standalone 스크립트에서 import가 안 되므로 여기 인라인한다.
// (워커 slack-presence-worker/src/crypto.js 도 같은 이유로 복제본을 갖고 있다.)
// 형식을 바꾸려면 세 곳을 함께 고쳐야 한다.
const KEY = Buffer.from(process.env.APP_ENCRYPTION_KEY, "hex");
if (KEY.length !== 32) throw new Error("APP_ENCRYPTION_KEY (hex 64자)가 필요합니다.");

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

function decrypt(payload) {
  const [iv, tag, data] = String(payload).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

// 인라인 복제본이 웹앱 형식과 어긋나면 여기서 바로 터진다.
if (decrypt(encrypt("xoxd-check")) !== "xoxd-check") throw new Error("crypto self-check 실패");

const APPLY = process.argv.includes("--apply");

// supabase-js는 Node 18에서 native WebSocket을 요구한다. 여기서 필요한 건 REST
// 뿐이므로 fetch로 직접 호출한다.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");

async function sbFetch(path, init = {}) {
  const res = await fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function authTest(xoxc, xoxd) {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Cookie: `d=${xoxd}`,
    },
    body: new URLSearchParams({ token: xoxc }),
  });
  return res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
}

// status 만 보면 안 된다 — needs_reauth 로 멈춘 행이 keeper 정리 과정에서 paused 로
// 덮이는 버그가 있었다(PresenceKeeper.stop). error 가 남아있는 행도 모두 집는다.
const rows = await sbFetch(
  "/rest/v1/connections?select=*&or=(status.in.(needs_reauth,error),error.not.is.null)"
);

console.log(`실패 상태 연결: ${rows.length}건${APPLY ? "" : "  (dry-run — 쓰기 없음)"}\n`);

const dead = [];
for (const row of rows) {
  let xoxc, xoxd;
  try {
    xoxc = decrypt(row.enc_xoxc);
    xoxd = decrypt(row.enc_xoxd);
  } catch (e) {
    console.log(`✗ ${row.id} ${row.team_name} — 복호화 실패 (${e.message})`);
    dead.push(row);
    continue;
  }

  let auth = await authTest(xoxc, xoxd);
  let fixedXoxd = null;
  if (!auth.ok && /[+/=]/.test(xoxd)) {
    const encoded = encodeURIComponent(xoxd);
    const retry = await authTest(xoxc, encoded);
    if (retry.ok) {
      auth = retry;
      fixedXoxd = encoded;
    }
  }

  if (!auth.ok) {
    console.log(`✗ ${row.id} ${row.team_name} — ${auth.error} (재연결 필요)`);
    dead.push(row);
    continue;
  }

  const note = fixedXoxd ? " [xoxd 인코딩 교정]" : "";
  console.log(`✓ ${row.id} ${row.team_name} — 유효 (${auth.user} @ ${auth.team})${note}`);
  if (APPLY) {
    const patch = {
      status: "pending",
      error: null,
      slack_user_id: auth.user_id,
      ...(fixedXoxd ? { enc_xoxd: encrypt(fixedXoxd) } : {}),
    };
    try {
      await sbFetch(`/rest/v1/connections?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      console.log(`  → pending 으로 되살림 (워커가 다음 폴링에 집어감)`);
    } catch (e) {
      console.log(`  → 업데이트 실패: ${e.message}`);
    }
  }
}

// 진짜 죽은 연결 → status를 needs_reauth 로 정규화하고, 안내할 이메일을 뽑는다.
// 정규화가 필요한 이유: paused 로 덮인 행은 대시보드가 "일시정지 ⚠ invalid_auth"
// 로만 보여줘서 사용자가 무엇을 해야 하는지 알 수 없다. needs_reauth 여야
// "확장으로 다시 연결하면 복구됩니다" 안내가 뜬다.
if (dead.length) {
  console.log(`\n재연결 안내가 필요한 사용자 ${dead.length}명:`);
  for (const row of dead) {
    const user = await sbFetch(
      `/auth/v1/admin/users/${encodeURIComponent(row.user_id)}`
    ).catch(() => null);
    console.log(`  ${user?.email || row.user_id}  (${row.team_name})`);

    if (row.status !== "needs_reauth") {
      if (!APPLY) {
        console.log(`    → status ${row.status} → needs_reauth 로 정규화 필요 (--apply)`);
        continue;
      }
      try {
        await sbFetch(`/rest/v1/connections?id=eq.${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "needs_reauth" }),
        });
        console.log(`    → status needs_reauth 로 정규화 (대시보드에 재연결 안내 표시)`);
      } catch (e) {
        console.log(`    → 정규화 실패: ${e.message}`);
      }
    }
  }
}
