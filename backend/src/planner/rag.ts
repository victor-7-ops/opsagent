import { ChromaClient, Collection } from "chromadb";
import { DefaultEmbeddingFunction } from "@chroma-core/default-embed";

const DEFAULT_TOP_K = 4;

let cachedClient: ChromaClient | undefined;
function getClient(): ChromaClient {
  if (!cachedClient) {
    const url = new URL(process.env.CHROMA_URL || "http://localhost:8000");
    cachedClient = new ChromaClient({
      host: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      ssl: url.protocol === "https:",
    });
  }
  return cachedClient;
}

function getCollectionName(): string {
  return process.env.CHROMA_POLICY_COLLECTION || "opsagent_policies";
}

async function getPolicyCollection(): Promise<Collection> {
  return getClient().getOrCreateCollection({
    name: getCollectionName(),
    embeddingFunction: new DefaultEmbeddingFunction(),
  });
}

// Pulls the top-K most relevant policy-doc chunks for a query (SPEC.md §5.2:
// "RAG-retrieved policy docs (top 4 chunks)"). Resilient by design — if
// ChromaDB is unreachable, planning should degrade to no policy context
// rather than fail the whole workflow.
export async function queryPolicyDocs(query: string, topK = DEFAULT_TOP_K): Promise<string[]> {
  try {
    const collection = await getPolicyCollection();
    const result = await collection.query({ queryTexts: [query], nResults: topK });
    return (result.documents[0] ?? []).filter((doc): doc is string => doc !== null);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`RAG retrieval failed, proceeding without policy context: ${(err as Error).message}`);
    return [];
  }
}

export async function ingestPolicyDocs(
  docs: { id: string; text: string; source: string }[],
): Promise<void> {
  const collection = await getPolicyCollection();
  await collection.upsert({
    ids: docs.map((d) => d.id),
    documents: docs.map((d) => d.text),
    metadatas: docs.map((d) => ({ source: d.source })),
  });
}
