import {
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  mintIdentityJwt,
  mintSystemJwt,
  type ToolsListResponseV1,
} from "@every-app/sdk/internal";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { workerEnv } = vi.hoisted(() => ({
  workerEnv: { AUTH_MODE: "everyapp" } as Record<string, unknown>,
}));
vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
  waitUntil: vi.fn(),
  DurableObject: class {
    readonly ctx = null;
  },
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  ensureUserRecord: vi.fn(async (_userId: string, email: string) => email),
}));
vi.mock("@/server/auth/delegated-organization", () => ({
  ensureSharedWorkspaceOrganization: vi.fn(async () => "shared-workspace"),
}));
vi.mock("@/server/features/activation/mcpActivation", () => ({
  recordExternalMcpToolCall: vi.fn(),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  incrementSelfHostMcpToolCallCount: vi.fn(async () => {}),
}));

import { everyAppTools } from "./tools";

// The fork's Worker, which the gateway mints every identity for.
const AUDIENCE = "every-acme-openseo";
const ISSUER = "https://apps.example.com";
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
};
let privateKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
  Object.assign(workerEnv, {
    EVERYAPP_APP_ID: "openseo",
    EVERYAPP_AUDIENCE: AUDIENCE,
    EVERYAPP_IDENTITY_ISSUER: ISSUER,
    EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([
      await exportSPKI(keys.publicKey),
    ]),
    EVERY_APP_ORG_ID: "org_1",
  });
});

function post(path: string, body: unknown, headers: Record<string, string>) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test env holds only the vars the tools contract reads
  const env = workerEnv as unknown as Env;
  return everyAppTools.fetch(
    new Request(`https://openseo.apps.example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

describe("OpenSEO's tools on the Every App gateway", () => {
  it("describes every tool within the gateway's catalog limits", async () => {
    const token = await mintSystemJwt(privateKeyPem, {
      audience: AUDIENCE,
      issuer: ISSUER,
      purpose: "tools.list",
    });
    const response = await post(
      TOOLS_LIST_PATH,
      { v: 1 },
      {
        [SYSTEM_HEADER]: token,
      },
    );

    expect(response.status).toBe(200);
    const catalog = await response.json<ToolsListResponseV1>();
    expect(catalog.warnings ?? []).toEqual([]);
    expect(catalog.tools).toHaveLength(102);
    expect(
      catalog.tools
        .filter((tool) =>
          [
            "list_content",
            "get_content_revision",
            "create_content_brief",
            "capture_content_source",
            "capture_content_urls",
            "save_content_revision",
            "archive_content",
            "export_content_revision",
            "request_content_review",
            "get_content_review",
          ].includes(tool.name),
        )
        .map(({ name, risk }) => ({ name, risk })),
    ).toEqual([
      { name: "archive_content", risk: "write" },
      { name: "capture_content_source", risk: "write" },
      { name: "capture_content_urls", risk: "write" },
      { name: "create_content_brief", risk: "write" },
      { name: "export_content_revision", risk: "read" },
      { name: "get_content_review", risk: "read" },
      { name: "get_content_revision", risk: "read" },
      { name: "list_content", risk: "read" },
      { name: "request_content_review", risk: "write" },
      { name: "save_content_revision", risk: "write" },
    ]);
    expect(
      catalog.tools
        .filter((tool) => tool.name.includes("site_authority"))
        .map(({ name, risk }) => ({ name, risk })),
    ).toEqual([
      { name: "check_site_authority_challenge", risk: "write" },
      { name: "get_site_authority", risk: "read" },
      { name: "issue_site_authority_challenge", risk: "write" },
      { name: "revoke_site_authority", risk: "write" },
    ]);
    expect(
      catalog.tools
        .filter((tool) =>
          [
            "get_audit_schedule",
            "estimate_audit_schedule",
            "save_audit_schedule",
            "list_audit_attempts",
            "get_audit_evidence",
            "compare_audit_evidence",
            "export_audit_evidence",
          ].includes(tool.name),
        )
        .map(({ name, risk }) => ({ name, risk })),
    ).toEqual([
      { name: "compare_audit_evidence", risk: "read" },
      { name: "estimate_audit_schedule", risk: "read" },
      { name: "export_audit_evidence", risk: "read" },
      { name: "get_audit_evidence", risk: "read" },
      { name: "get_audit_schedule", risk: "read" },
      { name: "list_audit_attempts", risk: "read" },
      { name: "save_audit_schedule", risk: "write" },
    ]);
    expect(catalog.instructions?.length).toBeLessThanOrEqual(1024);
    for (const tool of catalog.tools) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(2048);
      expect(
        JSON.stringify(tool.inputSchema).length,
        tool.name,
      ).toBeLessThanOrEqual(20 * 1024);
      expect(
        JSON.stringify(tool.outputSchema).length,
        tool.name,
      ).toBeLessThanOrEqual(20 * 1024);
    }
    // The gateway hides destructive tools from AI clients, so none is one:
    // deletes reach them as writes.
    expect(catalog.tools.filter((tool) => tool.risk === "destructive")).toEqual(
      [],
    );
    expect(
      catalog.tools.find((tool) => tool.name === "delete_report")?.risk,
    ).toBe("write");
  });

  it("runs a tool for the gateway user, returning OpenSEO's text and its data", async () => {
    const token = await mintIdentityJwt(privateKeyPem, {
      subject: {
        sub: "user_1",
        email: "ana@example.com",
        orgId: "org_1",
        orgRole: "member",
      },
      audience: AUDIENCE,
      issuer: ISSUER,
      channel: "mcp",
      actor: { sub: "oauth:conn_1" },
      scopes: ["mcp:read", "mcp:write"],
      toolCall: { id: "call_1", name: "whoami" },
    });
    const response = await post(
      TOOLS_CALL_PATH,
      { v: 1, name: "whoami", arguments: {}, callId: "call_1" },
      { [IDENTITY_HEADER]: token },
    );

    expect(response.status).toBe(200);
    const { result } = await response.json<{
      result: {
        content: { type: string; text: string }[];
        structuredContent: Record<string, unknown>;
      };
    }>();
    expect(result.content[0]?.text).toContain("Account: ana@example.com");
    expect(result.structuredContent).toMatchObject({
      userEmail: "ana@example.com",
      scopes: ["mcp:read", "mcp:write"],
      mode: "every-app",
    });
  });

  it("forwards the tool call's identity on the tool's own gateway calls", async () => {
    const sent: Request[] = [];
    Object.assign(workerEnv, {
      EVERY_APP_GATEWAY: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(new Request(input, init));
          return Response.json({
            status_code: 20000,
            tasks: [
              {
                status_code: 20000,
                result: [
                  {
                    location_code: 1013962,
                    location_name: "Catonsville,Maryland,United States",
                    location_type: "City",
                  },
                ],
              },
            ],
          });
        },
      },
      KV: { get: async () => null, put: async () => {} },
    });
    const token = await mintIdentityJwt(privateKeyPem, {
      subject: {
        sub: "user_1",
        email: "ana@example.com",
        orgId: "org_1",
        orgRole: "member",
      },
      audience: AUDIENCE,
      issuer: ISSUER,
      channel: "mcp",
      actor: { sub: "oauth:conn_1" },
      scopes: ["mcp:read"],
      toolCall: { id: "call_2", name: "search_serp_locations" },
    });
    try {
      const response = await post(
        TOOLS_CALL_PATH,
        {
          v: 1,
          name: "search_serp_locations",
          arguments: { query: "Catonsville", countryCode: "us" },
          callId: "call_2",
        },
        { [IDENTITY_HEADER]: token },
      );

      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.headers.get(IDENTITY_HEADER)).toBe(token);
      expect(sent[0]?.headers.get("x-everyapp-org")).toBeNull();
    } finally {
      delete workerEnv.EVERY_APP_GATEWAY;
      delete workerEnv.KV;
    }
  });
});
