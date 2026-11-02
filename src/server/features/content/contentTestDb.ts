import type {
  ContentWriteScope,
  PreparedRevisionWrite,
} from "./repositories/contentRevisionWrites";

export const contentTestScope: ContentWriteScope = {
  actor: {
    userId: "user",
    organizationId: "organization",
    role: "owner",
    surface: "web",
  },
  membershipId: "membership",
};
export const contentTestWrite: PreparedRevisionWrite = {
  mutationId: "create",
  requestHash: "hash",
  expectedHeadVersion: 0,
  expectedContextVersion: 0,
  sourceHashes: [],
  revision: {
    id: "revision",
    projectId: "project",
    contentId: "content",
    version: 1,
    parentRevisionId: null,
    brief: {
      target: "",
      objective: "Goal",
      audience: "Readers",
      outputKind: "article",
      topic: "Topic",
      locale: { language: "en", country: "US" },
    },
    markdown: "Body",
    metadata: {
      title: "Title",
      slug: "title",
      description: "Description",
      schemaSuggestion: "",
    },
    contextJson: "{}",
    contextVersion: 0,
    contextHash: "context",
    sourceSetHash: "sources",
    contentHash: "body",
    sourceIds: [],
    claims: [],
    openQuestions: [],
    omissions: [],
    createdAtMs: 1,
  },
  checkSet: {
    id: "checks",
    hash: "checks-hash",
    ruleVersion: "1",
    createdAtMs: 1,
    checks: [],
  },
};
