import { CopyButton } from "@/client/components/CopyButton";
import { getClientAuthMode } from "@/lib/auth-mode";
import { PRODUCT_REPOSITORY_URL } from "@/shared/product-help";

const link = "font-medium text-primary underline underline-offset-4";

function AgentGuide() {
  const mode = getClientAuthMode();
  const endpoint =
    typeof window === "undefined" ? "" : `${window.location.origin}/mcp`;
  if (mode === "everyapp")
    return (
      <>
        <p>
          Every App manages the MCP connection through its gateway. Open the{" "}
          <a className={link} href="/ai">
            AI page
          </a>{" "}
          to find the verified gateway URL and connection instructions.
        </p>
        <p>
          Cloud-hosted clients must be able to reach the gateway; localhost
          refers to their own machine, not yours.
        </p>
      </>
    );
  return (
    <>
      {(mode === "password" || mode === "hosted") && (
        <p>
          In{" "}
          <a className={link} href="/settings">
            Settings
          </a>
          , create an API key for a trusted MCP client. Treat the key like a
          password and never paste it into a public issue.
        </p>
      )}
      <p>
        Configure the client to connect to this MCP endpoint.
        {mode === "cloudflare_access" ? (
          " Cloudflare Access requires Managed OAuth and configured external access for the client."
        ) : mode === "local_noauth" ? (
          " Local no-auth does not require an API key."
        ) : (
          <>
            {" "}
            Use OAuth if supported; otherwise store the API key in the client’s
            secret settings as an <code>Authorization: Bearer</code> header.
          </>
        )}
      </p>
      <div className="flex items-center gap-2 rounded border p-3">
        <code className="min-w-0 flex-1 break-all">{endpoint}</code>
        <CopyButton
          value={endpoint}
          label="Copy MCP URL"
          successMessage="MCP URL copied"
          size="icon-xs"
          variant="ghost"
        />
      </div>
      <p>
        Cloud-hosted clients must be able to reach this address; localhost
        refers to their own machine, not yours. Use the AI page for
        client-specific setup.
      </p>
      <p>
        After connecting, call <code>whoami</code> and{" "}
        <code>list_projects</code> when available to verify the identity and
        project access. Do not run paid research to test the connection.
      </p>
    </>
  );
}

export const guideContent: Record<
  string,
  { title: string; content: React.ReactNode }
> = {
  agent: {
    title: "Connect an AI agent",
    content: (
      <>
        <AgentGuide />
      </>
    ),
  },
  crawler: {
    title: "Site crawler",
    content: (
      <>
        <p>
          Site audits request pages from your website. Make sure the site is
          reachable from your deployment and that its robots rules and security
          controls allow the OpenSEO-Audit/1.0 crawler.
        </p>
        <p>
          A blocked request or inaccessible page is not proof that all pages are
          affected. Check the audit details and site logs before changing access
          rules. For Shopify, see project Settings → Shopify to configure a
          crawler access signature when available; ask your administrator about
          CRAWLER_ACCESS_SECRET if setup is unavailable.
        </p>
      </>
    ),
  },
  rendering: {
    title: "JavaScript rendering",
    content: (
      <>
        <p>
          JavaScript rendering is optional. It requires a Cloudflare deployment
          with Browser Run, or a configured <code>CONTEXT_API_KEY</code>.
          Provider charges may apply.
        </p>
        <p>
          Regular crawling remains available without that key. Retry after the
          operator applies the configuration.
        </p>
      </>
    ),
  },
  authentication: {
    title: "Authentication",
    content: (
      <>
        <p>
          Password accounts use the email and password for this installation. If
          you cannot sign in or reset your password, contact your deployment
          administrator; self-hosted installations may require an operator to
          reset it. Local no-auth is intended only for a trusted network.
        </p>
        <p>
          Every App uses its gateway for sign-in and access. Ask your workspace
          administrator to check your membership and access to this app.
        </p>
        <p>
          For Cloudflare Access, ask your administrator to check the Access
          application, its allowed users, team domain, and audience for this
          deployment. External MCP clients also require Managed OAuth enabled on
          that Access application and their redirect URIs allowed.
        </p>
        <p>
          Confirm you are using the correct public URL. Do not share passwords,
          tokens, or other secrets in an issue.
        </p>
      </>
    ),
  },
  "docker-migration": {
    title: "Move from the old Docker image",
    content: (
      <>
        <p>
          Back up the existing installation and keep its old data volume. Update
          the old installation, let running work finish, and stop it. Identify
          its data volume and set LEGACY_VOLUME in deploy/standalone/.env for
          the new installation. Start the documented migration and inspect the
          init logs, then verify your data and reconnect integrations. The
          migration copies supported data; it does not delete the old volume.
        </p>
        <p>
          Follow the full{" "}
          <a
            className={link}
            href={`${PRODUCT_REPOSITORY_URL}/blob/test/docs/SELF_HOSTING_DOCKER.md#move-from-the-old-docker-image`}
          >
            Docker migration instructions
          </a>{" "}
          for the exact commands and limitations. Do not delete the old volume
          until the migration is verified.
        </p>
      </>
    ),
  },
  "rank-tracking": {
    title: "Rank tracking changes",
    content: (
      <>
        <p>
          Rank tracking compares positions for tracked keywords over time.
          Changes can reflect a site's position, search location, device or the
          availability of a fresh result.
        </p>
        <p>
          Check the selected location and dates and compare the current and
          earlier snapshots. DataForSEO must be configured for rank data;
          provider charges may apply.
        </p>
      </>
    ),
  },
};
