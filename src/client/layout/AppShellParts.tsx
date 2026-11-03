import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { AppBanner } from "@/client/layout/AppBanner";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { isEveryAppClientAuthMode } from "@/lib/auth-mode";

function SeoApiStatusBanners({
  shouldShowSeoApiWarning,
  seoApiKeyStatusError,
}: {
  shouldShowSeoApiWarning: boolean;
  seoApiKeyStatusError: boolean;
}) {
  const icon = <AlertTriangle className="size-4 shrink-0" />;
  const helpLink = (
    <Link
      {...dataforseoHelpLinkOptions}
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      help page
    </Link>
  );
  return (
    <>
      {shouldShowSeoApiWarning ? (
        <AppBanner variant="warning" icon={icon}>
          {isEveryAppClientAuthMode() ? (
            <>
              DataForSEO isn&apos;t set up on your Every App gateway yet. An
              owner or admin sets it with{" "}
              <code>pnpm everyapp secret set DATAFORSEO_API_KEY</code>. Steps on
              the {helpLink}.
            </>
          ) : (
            <>
              DataForSEO is not configured. Keyword, domain, backlink and rank
              data features are unavailable until an administrator sets it up.
              See the {helpLink}.
            </>
          )}
        </AppBanner>
      ) : null}

      {seoApiKeyStatusError ? (
        <AppBanner variant="info" icon={icon}>
          We could not verify your DataForSEO setup. If features are not
          working, check the setup steps on the {helpLink}.
        </AppBanner>
      ) : null}
    </>
  );
}

const DOCKER_MOVE_URL = "/help/docker-migration";
const DOCKER_MOVE_DISMISSED_KEY = "openseo:docker-move-dismissed";

// The old single-container Docker image builds the app at startup with this
// flag set (deploy/docker/Dockerfile), so only its users see the notice.
function LegacyDockerBanner() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DOCKER_MOVE_DISMISSED_KEY) === "1",
  );
  if (import.meta.env.VITE_OPENSEO_LEGACY_DOCKER !== "true" || dismissed) {
    return null;
  }
  return (
    <AppBanner variant="info" icon={<Info className="size-4 shrink-0" />}>
      A new OpenSEO Docker setup starts in seconds and supports accounts. This
      image keeps getting updates, and moving keeps your data.{" "}
      <a
        href={DOCKER_MOVE_URL}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        How to move
      </a>{" "}
      ·{" "}
      <button
        type="button"
        className="font-medium text-primary underline-offset-4 hover:underline"
        onClick={() => {
          localStorage.setItem(DOCKER_MOVE_DISMISSED_KEY, "1");
          setDismissed(true);
        }}
      >
        Dismiss
      </button>
    </AppBanner>
  );
}

export { LegacyDockerBanner, SeoApiStatusBanners };
