import * as http from "node:http";
import * as net from "node:net";
import * as vscode from "vscode";

export function stripAnsi(output: string): string {
  return output.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

export function isLocalServerHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "0.0.0.0" ||
    normalizedHostname === "::" ||
    normalizedHostname === "[::]" ||
    normalizedHostname === "[::1]" ||
    normalizedHostname.startsWith("127.")
  );
}

export function sanitizeUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;]+$/g, "");
}

interface UrlCandidateRecord {
  readonly candidate: string;
  readonly line: string;
}

export function extractUrlCandidates(
  output: string,
): UrlCandidateRecord[] {
  const records: UrlCandidateRecord[] = [];

  for (const line of output.split(/\r?\n/u)) {
    for (const match of line.matchAll(/\bhttps?:\/\/[^\s"'`<>)\]}]+/gi)) {
      const candidate = sanitizeUrlCandidate(match[0] || "");
      if (!candidate) {
        continue;
      }
      records.push({
        candidate,
        line,
      });
    }
  }

  return records;
}

function isLocalUrlCandidate(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return isLocalServerHost(url.hostname);
  } catch {
    return false;
  }
}

export function scoreServerUrlCandidate(
  candidate: string,
  line: string,
): number {
  let score = 0;

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();

    if (isLocalServerHost(hostname)) {
      score += 100;
    }

    if (/\blocal\b/i.test(line)) {
      score += 120;
    }

    if (/\bnetwork\b/i.test(line)) {
      score -= 25;
    }

    if (/\bastro\b/i.test(line) || /\bvite\b/i.test(line)) {
      score += 10;
    }
  } catch {
    return 0;
  }

  return score;
}

export function normalizeParsedServerBaseUri(
  candidate: string,
): vscode.Uri | null {
  try {
    const url = new URL(candidate);
    let hostname = url.hostname;

    if (
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "[::]" ||
      hostname === "[::1]"
    ) {
      hostname = "127.0.0.1";
    }

    const authority = url.port ? `${hostname}:${url.port}` : hostname;
    return vscode.Uri.parse(`${url.protocol}//${authority}`);
  } catch {
    return null;
  }
}

export function parseServerBaseUriFromTerminalOutput(
  output: string,
): vscode.Uri | null {
  const cleanedOutput = stripAnsi(output);
  const candidates = extractUrlCandidates(cleanedOutput);
  if (candidates.length === 0) {
    return null;
  }

  const localLineCandidates = candidates.filter(
    (record) =>
      /\blocal\b/i.test(record.line) && isLocalUrlCandidate(record.candidate),
  );
  const localCandidates = candidates.filter((record) =>
    isLocalUrlCandidate(record.candidate),
  );
  const candidatePool =
    localLineCandidates.length > 0 ? localLineCandidates : localCandidates;

  if (candidatePool.length === 0) {
    return null;
  }

  const bestCandidate = candidatePool
    .map((candidate) => ({
      candidate: candidate.candidate,
      score: scoreServerUrlCandidate(candidate.candidate, candidate.line),
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (!bestCandidate || bestCandidate.score < 1) {
    return null;
  }

  return normalizeParsedServerBaseUri(bestCandidate.candidate);
}

export async function pingServer(baseUri: vscode.Uri): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      baseUri.toString(),
      { timeout: 1500 },
      (response) => {
        response.resume();
        resolve(true);
      },
    );

    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

export function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export async function waitForTerminalShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | null> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise((resolve) => {
    const disposable = vscode.window.onDidChangeTerminalShellIntegration(
      (event) => {
        if (event.terminal !== terminal) {
          return;
        }

        cleanup();
        resolve(event.shellIntegration);
      },
    );
    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(terminal.shellIntegration || null);
    }, timeoutMs);

    const cleanup = (): void => {
      disposable.dispose();
      clearTimeout(timeoutHandle);
    };
  });
}

export async function waitForServerUri(
  baseUri: vscode.Uri,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServer(baseUri)) {
      return true;
    }

    await sleep(intervalMs);
  }

  return false;
}

export async function findAvailableLocalServerBaseUri(
  hostname: string,
  startPort: number,
  attempts: number,
): Promise<vscode.Uri | null> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (await isPortAvailable(hostname, port)) {
      return vscode.Uri.parse(`http://${hostname}:${port}`);
    }
  }

  return null;
}

async function isPortAvailable(
  hostname: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    const cleanup = (): void => {
      server.removeAllListeners();
    };

    server.once("error", () => {
      cleanup();
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => {
        cleanup();
        resolve(true);
      });
    });

    server.listen(port, hostname);
  });
}
