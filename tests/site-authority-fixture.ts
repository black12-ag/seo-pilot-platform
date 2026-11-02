import { expect, type Browser, type BrowserContext } from "@playwright/test";
import { z } from "zod";
import {
  authorityViewSchema,
  authorityInstructionsSchema,
} from "../src/types/schemas/siteAuthority";
import { callTool, type Credential } from "./mcp-isolation/mcp";

export function env(name: string) {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required browser fixture variable missing: ${name}`);
  return value;
}
export const statusSchema = z.looseObject({
  authority: authorityViewSchema,
  instructions: authorityInstructionsSchema.optional(),
});
export const organizationsSchema = z.array(z.looseObject({ id: z.string() }));
export const teamSchema = z.looseObject({
  members: z.array(
    z.looseObject({
      id: z.string(),
      role: z.string(),
      user: z.looseObject({ email: z.string() }),
    }),
  ),
});
const keySchema = z.looseObject({ id: z.string(), key: z.string() });

export async function signIn(
  browser: Browser,
  baseURL: string,
  kind: "OWNER" | "MEMBER" | "OUTSIDER",
) {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === baseURL
      ? route.continue()
      : route.abort(),
  );
  const response = await context.request.post("/api/auth/sign-in/email", {
    timeout: 15_000,
    data: {
      email: env(`SITE_AUTHORITY_${kind}_EMAIL`),
      password: env(`SITE_AUTHORITY_${kind}_PASSWORD`),
    },
  });
  expect(response.status(), "password fixture sign-in").toBe(200);
  return context;
}

export async function apiKey(context: BrowserContext) {
  const response = await context.request.post("/api/auth/api-key/create", {
    timeout: 15_000,
    data: { name: "Site authority acceptance" },
  });
  expect(response.status(), "fixture API key creation").toBe(200);
  const key = keySchema.parse(await response.json());
  const credential: Credential = {
    label: "site authority acceptance",
    secret: key.key,
  };
  return { id: key.id, credential };
}

export async function setRole(
  context: BrowserContext,
  data: { memberId: string; role: string; organizationId: string },
) {
  const response = await context.request.post(
    "/api/auth/organization/update-member-role",
    { data, timeout: 15_000 },
  );
  expect(response.status(), "reserved teammate role change").toBe(200);
}

export async function cleanupFixture(input: {
  contexts: BrowserContext[];
  keys: { context: BrowserContext; id: string }[];
  owner?: BrowserContext;
  memberId?: string;
  organizationId?: string;
  originalRole?: string;
  authority?: {
    credential: Credential;
    projectId: string;
    challengeId: string;
  };
}) {
  const failures: unknown[] = [];
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };
  const { owner, memberId, organizationId, originalRole, authority } = input;
  if (owner && authority)
    await attempt(async () => {
      const { credential, projectId, challengeId } = authority;
      const read = await callTool(owner.request, credential, {
        name: "get_site_authority",
        arguments: { projectId },
      });
      const state = statusSchema.parse(read.structuredContent);
      if (state.authority.challenge?.id === challengeId) {
        expect(
          (
            await callTool(owner.request, credential, {
              name: "revoke_site_authority",
              arguments: {
                projectId,
                expectedVersion: state.authority.version,
              },
            })
          ).isError,
          "revoke only this run's challenge",
        ).toBe(false);
      }
    });
  if (owner && memberId && organizationId && originalRole)
    await attempt(() =>
      setRole(owner, { memberId, role: originalRole, organizationId }),
    );
  await Promise.all(
    input.keys.map(({ context, id }) =>
      attempt(async () => {
        expect(
          (
            await context.request.post("/api/auth/api-key/delete", {
              timeout: 15_000,
              data: { keyId: id },
            })
          ).status(),
          "remove temporary acceptance key",
        ).toBe(200);
      }),
    ),
  );
  await Promise.all(
    input.contexts.map((context) =>
      attempt(async () => {
        try {
          expect(
            (
              await context.request.post("/api/auth/sign-out", {
                timeout: 15_000,
                data: {},
              })
            ).status(),
            "invalidate this test session",
          ).toBe(200);
          const session = await context.request.get("/api/auth/get-session", {
            timeout: 15_000,
          });
          expect(
            await session.json(),
            "test session invalid after sign-out",
          ).toBeNull();
        } finally {
          await context.close();
        }
      }),
    ),
  );
  if (failures.length)
    throw new Error(
      `Fixture cleanup incomplete (${failures.length} steps); verify reserved test state.`,
    );
}
