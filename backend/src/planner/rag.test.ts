import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, upsertMock, getOrCreateCollectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  upsertMock: vi.fn().mockResolvedValue(undefined),
  getOrCreateCollectionMock: vi.fn(),
}));

vi.mock("chromadb", () => ({
  ChromaClient: class MockChromaClient {
    getOrCreateCollection = getOrCreateCollectionMock;
  },
}));

vi.mock("@chroma-core/default-embed", () => ({
  DefaultEmbeddingFunction: class MockEmbeddingFunction {},
}));

import { ingestPolicyDocs, queryPolicyDocs } from "./rag";

describe("RAG policy retrieval", () => {
  beforeEach(() => {
    queryMock.mockReset();
    upsertMock.mockClear();
    getOrCreateCollectionMock.mockReset();
    getOrCreateCollectionMock.mockResolvedValue({ query: queryMock, upsert: upsertMock });
  });

  it("returns the top-K document chunks for a query", async () => {
    queryMock.mockResolvedValue({ documents: [["chunk one", "chunk two"]] });

    const chunks = await queryPolicyDocs("refund policy", 4);

    expect(chunks).toEqual(["chunk one", "chunk two"]);
    expect(queryMock).toHaveBeenCalledWith({ queryTexts: ["refund policy"], nResults: 4 });
  });

  it("defaults to top 4 when topK is omitted", async () => {
    queryMock.mockResolvedValue({ documents: [[]] });
    await queryPolicyDocs("anything");
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ nResults: 4 }));
  });

  it("filters out null documents", async () => {
    queryMock.mockResolvedValue({ documents: [["a", null, "b"]] });
    const chunks = await queryPolicyDocs("query");
    expect(chunks).toEqual(["a", "b"]);
  });

  it("degrades to an empty array (not a throw) when ChromaDB is unreachable", async () => {
    getOrCreateCollectionMock.mockRejectedValue(new Error("connection refused"));
    const chunks = await queryPolicyDocs("query");
    expect(chunks).toEqual([]);
  });

  it("ingestPolicyDocs upserts ids/documents/metadata", async () => {
    await ingestPolicyDocs([
      { id: "a#0", text: "chunk a", source: "a.md" },
      { id: "b#0", text: "chunk b", source: "b.md" },
    ]);

    expect(upsertMock).toHaveBeenCalledWith({
      ids: ["a#0", "b#0"],
      documents: ["chunk a", "chunk b"],
      metadatas: [{ source: "a.md" }, { source: "b.md" }],
    });
  });
});
