// /robots.txt 자동 생성 (Next.js App Router 파일 컨벤션).
//
// 대시보드·API·인증 경로는 색인 대상이 아니다(로그인 필수라 크롤러엔 빈 페이지로
// 보이고, 색인되면 검색결과 품질만 떨어진다).
//
// 다국어가 붙으면서 /en/dashboard, /ja/login 같은 경로도 생겼다. 와일드카드
// (/*/dashboard) 는 구글은 이해하지만 네이버 Yeti 는 보장되지 않으므로,
// 로케일별 경로를 전부 펼쳐서 명시한다.
import { SITE_URL } from "../lib/seo.js";
import { locales, defaultLocale } from "../i18n/routing.js";

const PRIVATE_PATHS = ["/dashboard", "/login"];

function disallowList() {
  const paths = ["/api/", "/auth/"];
  for (const locale of locales) {
    const prefix = locale === defaultLocale ? "" : `/${locale}`;
    for (const path of PRIVATE_PATHS) paths.push(`${prefix}${path}`);
  }
  return paths;
}

// AI 답변엔진 크롤러(AEO). `*` allow 로 이미 허용되지만, 명시해두면 각 봇이
// 자기 UA 규칙을 우선 확인할 때 확실히 잡히고 "환영" 신호가 된다.
// Google-Extended = 구글 AI(제미나이)·AI 개요 grounding 대상 포함 여부.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
];

export default function robots() {
  const disallow = disallowList();
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      // 네이버 크롤러. 별도 규칙이 없어도 위 * 규칙을 따르지만, 명시해두면
      // 서치어드바이저의 robots.txt 검증에서 확인이 쉽다.
      { userAgent: "Yeti", allow: "/", disallow },
      // AI 답변엔진 크롤러 — 색인/인용을 환영(단, 비공개 경로는 동일 차단).
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
