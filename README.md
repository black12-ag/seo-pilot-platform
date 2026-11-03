# SEO Pilot Platform (work in progress)

An open-source foundation for an integrated SEO workspace, derived from
[OpenSEO by Every App / Ben Senescu](https://github.com/every-app/open-seo) at
`1523750b76857324573a086b1d93bd3c3612b5b1`. See [NOTICE.md](./NOTICE.md) and the
preserved [MIT license](./LICENSE).

This fork adds an original public landing and project-scoped HTTPS/DNS site
authority shared by Settings, MCP and SAM. Its development branch also includes a
manual content studio with bounded public URL source capture, human review and
export. The upstream foundation supplies SEO research, audits, ranks, backlinks
and AI visibility with configured providers.
The complete integration of recurring evidence, grounded content and review,
publishing, automation, reporting and connectors remains in development; this
repository does not claim the full platform is ready.

Use Node.js 22 and the pinned package manager (`corepack pnpm`, version 10.30.1).
Install with `corepack pnpm install --frozen-lockfile`. For a local source build,
follow [SEO Pilot source self-hosting](./docs/SELF_HOSTING_SEO_PILOT.md), using
the source-build override, unique storage credentials, password accounts and a
loopback-only port. [Site authority](./web/content/docs/self-hosting/site-authority.md)
explains the exact-origin proof flow. Provider credentials are optional for starting the
application; data, model, and connected-service features require their own
credentials and may incur charges. Software self-hosting does not supply them.

The original OpenSEO README follows unchanged. Its hosted links, prices, and
feature descriptions refer to upstream OpenSEO, not a hosted SEO Pilot service.

---

# OpenSEO

> Open source alternative to Semrush and Ahrefs

OpenSEO is an SEO tool for _the people_. If tools like Semrush or Ahrefs are too expensive or bloated, OpenSEO is a pay-as-you-go alternative that you actually control.

> All-in-one SEO tool for you and your AI agent.

Connect with any agent like Claude Code, OpenClaw or Hermes. We have pre-built skills, but you can build your own to tailor OpenSEO to your needs.

<img width="100%" alt="openseo-keyword-research" src="https://github.com/user-attachments/assets/8ebdc439-3e72-41ab-8bde-8cda771ef2e8" />

## Hosted Version

Try OpenSEO for free on our website. If you want to support the project, a hosted subscription is $10/month.

[openseo.so](https://openseo.so)

### EveryApp

Host OpenSEO and other open source apps on our platform EveryApp.

[Self-host on EveryApp and give it a star →](https://github.com/every-app/every-app)

## Why use OpenSEO?

- Best in class MCP and AI Skills.
- Modern, simple UI.
  - Focused workflows instead of a bloated, complex SEO suite.
- No subscriptions.
  - Bring your own DataForSEO API key and pay only for what you use.
- Fork and vibe code your own custom tool.

## Main SEO Workflows

- Keyword research
- Rank tracking
- Competitor Insights
- Backlinks
- Site Audits
- AI Visibility

## OpenSEO MCP & Agent Skills

OpenSEO exposes an MCP server so AI agents like Claude Code, OpenClaw, and Hermes can use your SEO data directly. Agent Skills are reusable workflows that guide your agent through SEO tasks using the MCP.

- [Set up ChatGPT web or desktop](https://openseo.so/docs/chatgpt) (works on Free and paid ChatGPT plans)
- [Set up Codex](https://openseo.so/docs/codex-plugin)
- [Set up OpenSEO MCP](https://openseo.so/docs/mcp)
- [Set up OpenSEO Agent Skills](https://openseo.so/docs/skills/setup)

## Self-Hosting

OpenSEO supports two self-hosting paths. Both use email and password accounts: the first visitor creates the admin account, teammates join from invitation links, and MCP clients (Claude, ChatGPT, Codex, Cursor) sign in with the same accounts.

- **Docker** - On your own server or computer, with a prebuilt image that is ready in seconds. Works with Compose-based platforms such as Coolify, Portainer and Dokploy. See [`docs/SELF_HOSTING_DOCKER.md`](./docs/SELF_HOSTING_DOCKER.md).
  - Running the older single-container image? It keeps getting updates; [move to the new setup](./docs/SELF_HOSTING_DOCKER.md#move-from-the-old-docker-image) when you are ready, data included.
- **Cloudflare** - No server to run: one deploy command puts OpenSEO on your own Cloudflare account (works on the free plan). See [`docs/SELF_HOSTING_CLOUDFLARE.md`](./docs/SELF_HOSTING_CLOUDFLARE.md).

For security-conscious setups, two advanced options replace the accounts with your own network controls:

- **Cloudflare Access** in front of the Cloudflare deploy, so Cloudflare checks every request before it reaches OpenSEO. See [`docs/SELF_HOSTING_CLOUDFLARE.md`](./docs/SELF_HOSTING_CLOUDFLARE.md).
- **No sign-in on Docker**, behind Tailscale, a private network or your own authenticating proxy. See [Without sign-in](./docs/SELF_HOSTING_DOCKER.md#without-sign-in-advanced).

Either way, you need a DataForSEO API key to get SEO data. See [`docs/DATAFORSEO_API_KEY.md`](./docs/DATAFORSEO_API_KEY.md).

## Costs

OpenSEO needs a [DataForSEO](https://dataforseo.com/?aff=255379) API key so that you can get SEO data. You pay them directly when self hosting.

See [openseo.so/pricing](https://openseo.so/pricing)

When you self host, your costs will be slightly lower than the estimates on our website. The way the hosted service makes money is by charging 28% extra for every request we make to DataForSEO.

## Local Development

See [`docs/LOCAL_DEVELOPMENT.md`](./docs/LOCAL_DEVELOPMENT.md).

## Contributing

Creating clear issues is the best way to contribute.

Read more here: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)

We have this skill: `/simple-issue-description` which helps.

```sh
npx skills add every-app/open-seo --skill simple-issue-description
```

## Community

Join Discord to chat: [Discord](https://discord.gg/c9uGs3cFXr)

Follow along for updates:

- Follow on X: https://x.com/bensenescu
- Sign up for the mailing list on our website: [openseo.so](https://openseo.so)
