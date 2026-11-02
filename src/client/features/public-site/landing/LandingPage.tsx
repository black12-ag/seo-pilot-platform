import { LandingIllustration } from "./LandingIllustration";

const repository = "https://github.com/black12-ag/seo-pilot-platform";
const installGuide = `${repository}/blob/test/web/content/docs/self-hosting/docker.md`;

export function LandingPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="public-header">
        <nav
          className="landing-container public-nav"
          aria-label="Main navigation"
        >
          <a className="brand" href="/welcome" aria-label="SEO Pilot home">
            <img src="/seo-pilot-mark.svg" width="27" height="27" alt="" />
            <span>seo pilot</span>
            <small>OPEN SOURCE</small>
          </a>
          <div className="nav-links">
            <a className="desktop-link" href="#product">
              Product
            </a>
            <a className="desktop-link" href="#self-hosting">
              Self-hosting
            </a>
            <a className="desktop-link" href={installGuide}>
              Docs
            </a>
            <a className="desktop-link" href="/">
              Sign in
            </a>
            <a className="landing-button" href="/">
              Open workspace <span aria-hidden="true">↗</span>
            </a>
          </div>
        </nav>
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="landing-container">
            <p className="eyebrow">
              The open-source workspace for better search
            </p>
            <h1 id="hero-heading">
              A little more visible.
              <br />
              Every day.
            </h1>
            <p className="hero-description">
              See the evidence. Choose the next useful change. We’re building
              one workspace for technical SEO, AI visibility and content your
              team can review.
            </p>
            <div className="hero-actions">
              <a className="landing-button" href={installGuide}>
                Start self-hosting <span aria-hidden="true">↗</span>
              </a>
              <a className="text-action" href="/">
                Explore the workspace <span aria-hidden="true">→</span>
              </a>
            </div>
            <p className="hero-note">
              Free software. Your providers. Hosting and provider usage cost
              extra.
            </p>
            <LandingIllustration />
          </div>
        </section>
        <section
          id="product"
          className="landing-container product-section"
          aria-labelledby="product-heading"
        >
          <div className="section-intro">
            <h2 id="product-heading">
              Less noise.
              <br />
              More useful work.
            </h2>
            <p>
              Search work gets scattered between audits, spreadsheets, AI
              answers and half-finished drafts. Our direction is to bring the
              evidence and the next step together, while keeping you in control
              of your website.
            </p>
          </div>
          <div className="feature-grid">
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                ⌁
              </span>
              <p className="feature-stage">Existing foundation</p>
              <h3>Know where you stand.</h3>
              <p>
                The OpenSEO foundation includes audits, keyword and competitor
                research, ranks, backlinks and AI tracking. Data features need
                configured providers.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                ▤
              </span>
              <p className="feature-stage">Planned integration</p>
              <h3>Make something useful.</h3>
              <p>
                Connect findings to sourced briefs, focused drafts and immutable
                revisions, with a shared review flow before publishing.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                ↻
              </span>
              <p className="feature-stage">Planned integration</p>
              <h3>Keep the work moving.</h3>
              <p>
                Bring daily routines, budgets, publishing permissions and a
                clear run history together. These integrated workflows are still
                to come.
              </p>
            </article>
          </div>
          <section
            id="self-hosting"
            className="self-hosting"
            aria-labelledby="selfhost-heading"
          >
            <div>
              <p className="eyebrow">Your platform. Your choice.</p>
              <h2 id="selfhost-heading">
                A workspace you can
                <br />
                make your own.
              </h2>
              <p>
                Start with the attributed OpenSEO foundation. Self-host with
                password authentication and invited teammates, then connect the
                providers you choose. External data, models, rendering and
                hosting have their own costs.
              </p>
              <a className="landing-button" href={installGuide}>
                Read the install guide <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="platform-map">
              <p>THE PLATFORM WE’RE BUILDING</p>
              <ul>
                <li>Sites &amp; brand context</li>
                <li>Search &amp; AI evidence</li>
                <li>Content &amp; review history</li>
                <li>Publishing &amp; rollback</li>
                <li>Daily routines &amp; reports</li>
              </ul>
              <p>
                Website · API · MCP
                <br />
                One shared service layer
              </p>
            </div>
          </section>
          <section
            className="section-intro build-status"
            aria-labelledby="status-heading"
          >
            <h2 id="status-heading">
              Work you can inspect.
              <br />A direction you can follow.
            </h2>
            <div>
              <p className="eyebrow">Early build · development in progress</p>
              <p>
                The foundation currently implements upstream OpenSEO modules.
                The full integrated SEO Pilot product is planned; this page
                describes that direction, not a completed release.
              </p>
              <a className="source-link" href={repository}>
                Inspect the public source <span aria-hidden="true">↗</span>
              </a>
            </div>
          </section>
        </section>
      </main>
      <footer className="landing-container public-footer">
        <p>
          SEO Pilot · Search work, on your terms.
          <br />
          <span>
            Built on <a href="https://github.com/every-app/open-seo">OpenSEO</a>{" "}
            · MIT licensed
          </span>
        </p>
        <nav aria-label="Footer navigation">
          <a href={installGuide}>Documentation</a>
          <a href="#self-hosting">Self-hosting</a>
          <a href={repository}>Source code</a>
        </nav>
      </footer>
    </>
  );
}
