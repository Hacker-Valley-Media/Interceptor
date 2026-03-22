import { config } from "./config";
import { mkdirSync, existsSync } from "fs";
import { join, basename } from "path";

interface SessionMessage {
  type?: string;
  message?: { role?: string; content?: string | unknown[] };
  [key: string]: unknown;
}

function extractTextContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.text) return block.text;
        if (block?.content) return extractTextContent(block.content);
        if (block?.input) return JSON.stringify(block.input).slice(0, 500);
        return "";
      })
      .join("\n");
  }
  return "";
}

function isSlopRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("slop ") ||
    lower.includes("slop-browser") ||
    lower.includes("/slop") ||
    lower.includes("dist/slop") ||
    lower.includes("slop click") ||
    lower.includes("slop type") ||
    lower.includes("slop navigate") ||
    lower.includes("slop screenshot") ||
    lower.includes("slop tree") ||
    lower.includes("slop state") ||
    lower.includes("slop find") ||
    lower.includes("slop tabs") ||
    lower.includes("slop batch") ||
    lower.includes("slop eval") ||
    lower.includes("slop keys") ||
    lower.includes("mcp__claude-in-chrome") ||
    lower.includes("claude-in-chrome") ||
    lower.includes("browser skill") ||
    lower.includes("browser automation") ||
    lower.includes("error clicking") ||
    lower.includes("error navigating") ||
    lower.includes("screenshot") && lower.includes("browser") ||
    lower.includes("slop scroll") ||
    lower.includes("slop text") ||
    lower.includes("slop diff") ||
    lower.includes("slop wait")
  );
}

export async function extractExcerpts(
  sessionPaths: string[],
  outputDir: string
): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true });

  const excerptPaths: string[] = [];
  const maxSessions = config.evaluation.maxSessionsPerRun;
  const contextWindow = config.evaluation.contextWindowMessages;

  const sessionsToProcess = sessionPaths.slice(0, maxSessions);

  for (const sessionPath of sessionsToProcess) {
    if (!existsSync(sessionPath)) continue;

    const file = Bun.file(sessionPath);
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    const messages: { index: number; text: string; raw: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed: SessionMessage = JSON.parse(lines[i]);
        const content = parsed.message?.content;
        if (!content) continue;
        const textContent = extractTextContent(content);
        if (textContent.length > 0) {
          messages.push({ index: i, text: textContent, raw: lines[i] });
        }
      } catch {
        continue;
      }
    }

    const slopIndices = new Set<number>();
    for (let mi = 0; mi < messages.length; mi++) {
      if (isSlopRelated(messages[mi].text)) {
        for (
          let j = Math.max(0, mi - contextWindow);
          j <= Math.min(messages.length - 1, mi + contextWindow);
          j++
        ) {
          slopIndices.add(j);
        }
      }
    }

    if (slopIndices.size === 0) continue;

    const sortedIndices = Array.from(slopIndices).sort((a, b) => a - b);
    const excerptMessages: string[] = [];
    let tokenEstimate = 0;
    const maxTokens = config.evaluation.maxExcerptTokens;

    for (const idx of sortedIndices) {
      const msg = messages[idx];
      const truncated =
        msg.text.length > 2000 ? msg.text.slice(0, 2000) + "..." : msg.text;
      const tokens = Math.ceil(truncated.length / 4);
      if (tokenEstimate + tokens > maxTokens) break;
      tokenEstimate += tokens;
      excerptMessages.push(truncated);
    }

    if (excerptMessages.length === 0) continue;

    const sessionId = basename(sessionPath, ".jsonl");
    const outputPath = join(outputDir, `${sessionId}.txt`);
    const header = `SESSION: ${sessionPath}\nEXCERPTS: ${excerptMessages.length} messages (${slopIndices.size} slop-related)\n${"=".repeat(80)}\n\n`;
    await Bun.write(outputPath, header + excerptMessages.join("\n---\n"));
    excerptPaths.push(outputPath);
  }

  return excerptPaths;
}

if (import.meta.main) {
  const sessionsFile = config.paths.sessionsFile;
  const file = Bun.file(sessionsFile);
  if (!(await file.exists())) {
    console.error(`No sessions file at ${sessionsFile}`);
    process.exit(1);
  }
  const sessions: string[] = await file.json();
  if (sessions.length === 0) {
    console.log("No sessions to process");
    process.exit(0);
  }
  const excerpts = await extractExcerpts(sessions, config.paths.excerptsDir);
  console.log(`Extracted ${excerpts.length} session excerpts`);
}
