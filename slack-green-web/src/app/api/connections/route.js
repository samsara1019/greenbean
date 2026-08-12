import { NextResponse } from "next/server";
import { requireUserId } from "../../../lib/auth.js";
import { listConnections, createConnection } from "../../../lib/db.js";

// 이 라우트들은 node crypto/fs를 쓰므로 Edge가 아닌 Node 런타임에서 실행.
export const runtime = "nodejs";
// GET이 빌드타임에 정적 캐시되지 않도록 강제.
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId, response } = await requireUserId();
  if (response) return response;
  const items = await listConnections(userId);
  return NextResponse.json({ items });
}

// 저장 전에 자격증명이 실제로 먹히는지 Slack에 확인한다.
// 확인 없이 저장하면 사용자는 "연결 완료"를 보고, 몇 분 뒤 워커가 invalid_auth를
// 발견해 대시보드에 "재인증 필요"만 남는다 — 무엇이 잘못됐는지 알 수 없다.
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

const AUTH_MESSAGE = {
  invalid_auth:
    "Slack 세션이 만료됐습니다. app.slack.com 탭을 새로고침(또는 다시 로그인)한 뒤 다시 연결해 주세요.",
  not_authed:
    "Slack 세션이 만료됐습니다. app.slack.com 탭을 새로고침(또는 다시 로그인)한 뒤 다시 연결해 주세요.",
  token_revoked: "Slack 토큰이 폐기됐습니다. 다시 로그인한 뒤 연결해 주세요.",
  token_expired: "Slack 토큰이 만료됐습니다. 다시 로그인한 뒤 연결해 주세요.",
  account_inactive: "비활성화된 Slack 계정입니다.",
};

export async function POST(request) {
  const { userId, response } = await requireUserId();
  if (response) return response;
  const body = await request.json();

  if (!body.xoxc || !body.xoxd) {
    return NextResponse.json({ error: "xoxc, xoxd는 필수입니다." }, { status: 400 });
  }

  // d 쿠키 값은 퍼센트 인코딩된 상태로 저장·전송된다. 수동 입력 경로에서 디코딩된
  // 값을 붙여넣는 일이 있어, 실패하면 인코딩해서 한 번 더 시도한다.
  let xoxd = body.xoxd;
  let auth = await authTest(body.xoxc, xoxd);
  if (!auth.ok && /[+/=]/.test(xoxd)) {
    const encoded = encodeURIComponent(xoxd);
    const retry = await authTest(body.xoxc, encoded);
    if (retry.ok) {
      xoxd = encoded;
      auth = retry;
    }
  }
  if (!auth.ok) {
    return NextResponse.json(
      { error: AUTH_MESSAGE[auth.error] || `Slack 인증 실패 (${auth.error})` },
      { status: 400 }
    );
  }

  try {
    const created = await createConnection(userId, {
      teamName: body.teamName || auth.team,
      xoxc: body.xoxc,
      xoxd,
      slackUserId: auth.user_id,
      schedule: body.schedule,
    });
    return NextResponse.json({ item: created }, { status: 201 });
  } catch (e) {
    // 개수 제한 초과 → 403
    if (e.code === "LIMIT") {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
}
