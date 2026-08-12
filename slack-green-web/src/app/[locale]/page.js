import { getTranslations, setRequestLocale } from "next-intl/server";
import { businessLine, contactLine } from "../../lib/business.js";
import { localeUrl, pageMetadata, SITE_URL, SITE_NAME, OG_IMAGE } from "../../lib/seo.js";
import { Link } from "../../i18n/navigation.js";
import { HTML_LANG } from "../../i18n/routing.js";
import LocaleSwitcher from "../../components/locale-switcher.js";

// 메시지 키 목록. 카드 6개·스텝 3개·FAQ 6개를 배열로 돌려 JSX 중복을 없앤다.
// 키 순서가 화면 순서다.
const FEATURES = ["real", "hours", "cloud", "setup", "security", "multi"];
const FEATURE_ICON = {
  real: "🟢",
  hours: "🕘",
  cloud: "☁️",
  setup: "🧩",
  security: "🔒",
  multi: "🏢",
};
const STEPS = ["connect", "schedule", "run"];
// 한시 무료 정책 플래그(대시보드와 같은 값). 켜져 있으면 가격 카드에 무료 배지를
// 붙이고 결제 안내를 무료 안내로 바꾼다.
const FREE_PRO = process.env.NEXT_PUBLIC_FREE_PRO === "1";

const FAQ_KEYS = ["q1", "q2", "q3", "q4", "q5", "q6"];

export async function generateMetadata({ params: { locale } }) {
  const t = await getTranslations({ locale, namespace: "landing.meta" });
  return pageMetadata({
    locale,
    title: t("title"),
    description: t("description"),
    path: "/",
  });
}

// 구조화 데이터. 구글이 이걸 읽어 검색결과에 FAQ 아코디언·앱 정보(가격 등)를
// 표시할 수 있다. 네이버도 일부 스키마를 참고한다.
// ⚠️ inLanguage 와 FAQ 텍스트는 그 페이지의 언어와 일치해야 한다 — 한국어
// 스키마를 영어 페이지에 붙이면 불일치로 리치 결과를 받지 못한다.
function StructuredData({ locale, t, tFaq }) {
  const json = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Green Bean",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Chrome",
      url: localeUrl(locale, "/"),
      description: t("meta.description"),
      inLanguage: HTML_LANG[locale],
      offers: {
        "@type": "Offer",
        price: "4900",
        priceCurrency: "KRW",
        description: t("pricing.pro.chip"),
        url: `${localeUrl(locale, "/")}#pricing`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: HTML_LANG[locale],
      mainEntity: FAQ_KEYS.map((k) => ({
        "@type": "Question",
        name: tFaq(`${k}.q`),
        acceptedAnswer: { "@type": "Answer", text: tFaq(`${k}.a`) },
      })),
    },
    // 엔티티 명확화(AEO): AI/검색이 "무엇/어느 사이트"인지 확실히 인식하게 한다.
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
      logo: OG_IMAGE.url,
      // 공식 소셜 계정 — AI/검색의 엔티티 신뢰도(sameAs)를 높인다.
      sameAs: [
        "https://www.instagram.com/greenbeen.app/",
        "https://www.threads.com/@greenbeen.app",
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: localeUrl(locale, "/"),
      inLanguage: HTML_LANG[locale],
    },
  ];
  return (
    <script
      type="application/ld+json"
      // 번역 문자열만 들어가므로 XSS 위험이 없다.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(json) }}
    />
  );
}

export default async function Landing({ params: { locale } }) {
  setRequestLocale(locale);

  const t = await getTranslations("landing");
  const tFaq = await getTranslations("landing.faq");
  const c = await getTranslations("common");

  // 메시지 안의 <b> 를 실제 <strong> 으로 렌더한다.
  const bold = { b: (chunks) => <strong>{chunks}</strong> };

  return (
    <>
      <StructuredData locale={locale} t={t} tFaq={tFaq} />
      <header className="container">
        <nav className="nav">
          <div className="brand">
            <span className="dot" /> Green Bean
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <LocaleSwitcher />
            <a className="btn btn-ghost" href="#pricing">
              {c("nav.pricing")}
            </a>
            <Link className="btn btn-ghost" href="/blog">
              {c("nav.guides")}
            </Link>
            <Link className="btn btn-primary" href="/login">
              {c("nav.start")}
            </Link>
          </div>
        </nav>
      </header>

      <main className="container">
        {/* HERO */}
        <div className="hero">
          <span className="chip chip-success">{t("hero.chip")}</span>
          <h1>
            {t("hero.titleTop")}
            <br />
            {t("hero.titleBottomBefore")}
            <span className="hl">{t("hero.titleHighlight")}</span>
            {t("hero.titleBottomAfter")}
          </h1>
          <p className="lead">{t.rich("hero.lead", bold)}</p>
          <div className="cta-row">
            <Link className="btn btn-lg btn-primary" href="/login">
              {c("cta.startFree")}
            </Link>
            <a className="btn btn-lg btn-secondary" href="#how">
              {c("cta.howItWorks")}
            </a>
          </div>
        </div>

        {/* FEATURES */}
        <section id="features">
          <h2 className="section-title">{t("features.title")}</h2>
          <p className="section-sub">{t("features.sub")}</p>
          <div className="grid">
            {FEATURES.map((key) => (
              <div className="card" key={key}>
                <div className="ico" aria-hidden="true">
                  {FEATURE_ICON[key]}
                </div>
                <h3>{t(`features.${key}.title`)}</h3>
                <p>{t(`features.${key}.body`)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* HOW */}
        <section id="how">
          <h2 className="section-title">{t("how.title")}</h2>
          <p className="section-sub">{t("how.sub")}</p>
          <div className="steps">
            {STEPS.map((key) => (
              <div className="step" key={key}>
                <h3>{t(`how.${key}.title`)}</h3>
                <p className="muted">{t(`how.${key}.body`)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing">
          <h2 className="section-title">{t("pricing.title")}</h2>
          <p className="section-sub">{t("pricing.sub")}</p>
          <div className="price-wrap">
            <div className="price">
              <div className="price-head">
                <span className="chip chip-filter">{t("pricing.free.chip")}</span>
              </div>
              <div className="price-body">
                <div className="amt">
                  {t("pricing.free.amount")}
                  <span className="per">{t("pricing.free.per")}</span>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {t("pricing.free.note")}
                </p>
                <ul>
                  <li>{t("pricing.free.f1")}</li>
                  <li>{t("pricing.free.f2")}</li>
                  <li>{t("pricing.free.f3")}</li>
                </ul>
                <Link className="btn btn-secondary" href="/login">
                  {c("cta.startFree")}
                </Link>
              </div>
            </div>

            <div className="price featured">
              <div className="price-head">
                <span className="chip">{t("pricing.pro.chip")}</span>
                {/* 한시 무료 정책 중에는 가격만 보이면 이탈 요인이 된다 —
                    지금 결제 없이 쓸 수 있다는 사실을 가격 옆에 붙인다. */}
                {FREE_PRO && (
                  <span className="chip chip-success">
                    {t("pricing.freeNow.badge")}
                  </span>
                )}
              </div>
              <div className="price-body">
                <div className="amt">
                  {t("pricing.pro.amount")}
                  <span className="per">{t("pricing.pro.per")}</span>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {FREE_PRO ? t("pricing.freeNow.note") : t("pricing.pro.note")}
                </p>
                <ul>
                  <li>{t("pricing.pro.f1")}</li>
                  <li>{t("pricing.pro.f2")}</li>
                  <li>{t("pricing.pro.f3")}</li>
                  <li>{t("pricing.pro.f4")}</li>
                </ul>
                <Link className="btn btn-primary" href="/login">
                  {c("cta.startTrial")}
                </Link>
              </div>
            </div>
          </div>

          {/* 결제(또는 무료 정책) 안내 — 가입 전에 보여야 한다. */}
          <div className="notice" style={{ marginTop: 20 }}>
            <span aria-hidden="true">{FREE_PRO ? "🎁" : "💳"}</span>
            <p style={{ margin: 0 }}>
              {FREE_PRO
                ? t.rich("pricing.freeNow.notice", bold)
                : t.rich("pricing.payment", bold)}
            </p>
          </div>
        </section>

        {/* NOTICE */}
        <section>
          <div className="notice">
            <span aria-hidden="true">⚠️</span>
            <p style={{ margin: 0 }}>{t.rich("disclaimer", bold)}</p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq">
          <h2 className="section-title">{tFaq("title")}</h2>
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            {FAQ_KEYS.map((key) => (
              <div className="faq-item" key={key}>
                <h4>{tFaq(`${key}.q`)}</h4>
                <p>{tFaq(`${key}.a`)}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <div className="container">
          <div style={{ marginBottom: 8 }}>
            <Link href="/blog">{c("footer.blog")}</Link> ·{" "}
            <Link href="/guide">{c("footer.guide")}</Link> ·{" "}
            <Link href="/terms">{c("footer.terms")}</Link> ·{" "}
            <Link href="/refund">{c("footer.refund")}</Link> ·{" "}
            <Link href="/privacy">{c("footer.privacy")}</Link>
          </div>
          {/* 사업자정보는 전자상거래법상 한국어 표기 의무 사항이라 번역하지 않는다. */}
          <div className="biz-info">
            {businessLine()}
            <br />
            {contactLine()}
          </div>
          <div style={{ marginTop: 8 }}>{c("footer.copyright")}</div>
        </div>
      </footer>
    </>
  );
}
