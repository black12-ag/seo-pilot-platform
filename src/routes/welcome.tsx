import { createFileRoute } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingPage } from "@/client/features/public-site/landing/LandingPage";
import landingCss from "@/client/features/public-site/landing/landing.css?raw";
import illustrationCss from "@/client/features/public-site/landing/illustration.css?raw";

// Public static document, like the existing raw report routes: it bypasses
// the private ClientOnly shell without changing any workspace or API gate.
export const Route = createFileRoute("/welcome")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          "<!doctype html>" +
            renderToStaticMarkup(
              <html lang="en">
                <head>
                  <meta charSet="utf-8" />
                  <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                  />
                  <title>
                    SEO Pilot — Open-source search workspace, in progress
                  </title>
                  <meta
                    name="description"
                    content="An open-source SEO workspace in development. Self-host the OpenSEO foundation today and follow the plan for connected search evidence, content and review."
                  />
                  <meta name="theme-color" content="#111611" />
                  <meta
                    property="og:title"
                    content="SEO Pilot — A little more visible. Every day."
                  />
                  <meta
                    property="og:description"
                    content="An open-source search workspace in development. Your software, your providers, your next useful change."
                  />
                  <meta property="og:type" content="website" />
                  <link
                    rel="icon"
                    type="image/svg+xml"
                    href="/seo-pilot-mark.svg"
                  />
                  <style>{landingCss + illustrationCss}</style>
                </head>
                <body className="public-landing">
                  <LandingPage />
                </body>
              </html>,
            ),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=0, must-revalidate",
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "strict-origin-when-cross-origin",
            },
          },
        ),
    },
  },
});
