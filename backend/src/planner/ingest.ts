import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ingestPolicyDocs } from "./rag";

dotenv.config();

const CORPUS_DIR = path.resolve(__dirname, "../../../docs/demo-corpus");

// Simple paragraph-level chunking — good enough for the small synthetic
// policy corpus this project ships with.
function chunkMarkdown(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

async function main() {
  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log(`No .md files found in ${CORPUS_DIR}`);
    return;
  }

  const docs = files.flatMap((file) => {
    const text = fs.readFileSync(path.join(CORPUS_DIR, file), "utf8");
    return chunkMarkdown(text).map((chunk, i) => ({
      id: `${file}#${i}`,
      text: chunk,
      source: file,
    }));
  });

  await ingestPolicyDocs(docs);
  console.log(`Ingested ${docs.length} chunks from ${files.length} files into ChromaDB.`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
