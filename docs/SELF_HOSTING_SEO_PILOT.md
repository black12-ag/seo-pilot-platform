# Self-host SEO Pilot from source

SEO Pilot is a development build. This guide builds this fork's `test` branch;
there is no published SEO Pilot container image yet. The complete integrated
platform is still being implemented.

## Start locally

Install Docker Engine with Compose or Docker Desktop. Clone the fork:

```sh
git clone --branch test https://github.com/black12-ag/seo-pilot-platform.git
cd seo-pilot-platform
cp deploy/standalone/.env.example deploy/standalone/.env
```

Edit `deploy/standalone/.env`. Choose your own storage secret, and add the local
image name so the source build has its own tag:

```dotenv
STORAGE_ACCESS_KEY=seo-pilot
STORAGE_SECRET_KEY=replace-with-your-own-long-random-secret
OPENSEO_IMAGE=seo-pilot-platform:local
AUTH_MODE=password
BETTER_AUTH_URL=http://localhost:3001
PORT=3001
```

You can generate a storage secret locally with `openssl rand -hex 32`. Keep the
environment file private and out of Git. If you choose another port, update both
`PORT` and `BETTER_AUTH_URL`.

Build and start the isolated installation:

```sh
docker compose --project-name seo-pilot --env-file deploy/standalone/.env -f deploy/standalone/compose.yaml -f deploy/standalone/compose.build.yaml up -d --build
```

Open `http://localhost:3001/welcome`, then **Open workspace**. The first visitor
creates the administrator account; later teammates join through invitations.
Create that account before exposing the installation publicly. The Compose port
binds to loopback by default. Public hosting requires HTTPS and the matching
`BETTER_AUTH_URL`.

The initial build downloads dependencies and the pinned runtime. Later builds
reuse Docker's cache. It installs Debian packages over verified HTTPS and checks
the runtime binary's checksum.

## Providers and verification

The app starts without provider keys. Configure your own providers to use their
data, models or rendering; their usage and your hosting have separate costs.
Unavailable providers remain visible as unavailable.

Site verification is in **Settings → Integrations → Site authority**. Use the
[site authority guide](../web/content/docs/self-hosting/site-authority.md) for an
exact HTTPS origin and its file or DNS instructions. Verification does not
connect a CMS or publish a change. The complete content/publishing automation
flow remains in development.

The development branch's [recurring audit guide](../web/content/docs/self-hosting/recurring-audits.md)
describes opt-in plain HTTP schedules, the finite installation policy, daily
allowances and evidence. Keep the policy unset until the installation and
schedules have been reviewed. Paid recurring rendering/Lighthouse and the
remaining complete-platform modules are still in development.

The development branch's [manual content studio guide](../web/content/docs/self-hosting/content-studio.md)
describes briefs, attributed sources, Markdown revisions, human review and
exports. Public URL capture, paid generation and publishing remain unavailable.

## Stop and restart

```sh
docker compose --project-name seo-pilot --env-file deploy/standalone/.env -f deploy/standalone/compose.yaml stop
docker compose --project-name seo-pilot --env-file deploy/standalone/.env -f deploy/standalone/compose.yaml up -d
```

Keep the named volumes: they hold accounts, configuration and application data.
Removing volumes deletes that state.

## Back up before updating

From the repository root, use the existing backup utility with the same project:

```sh
cd deploy/standalone
COMPOSE_PROJECT_NAME=seo-pilot node ../../scripts/celld/backup.mjs backup /absolute/private/new-backup-directory
cd ../..
```

The destination must be new. The utility briefly stops this installation,
archives storage/configuration, records checksums, and restarts its previously
running services. The backup contains credentials; store it privately.
The host needs Node.js 22 to run this backup utility.

After backing up, update the source and rerun the source-build command above:

```sh
git pull --ff-only origin test
```

Preserve your environment file, image tag, project name and volumes. The
[upstream operations reference](./SELF_HOSTING_DOCKER.md) explains provider
configuration and other operational options; the fork/source-build steps here
select SEO Pilot's additions.
