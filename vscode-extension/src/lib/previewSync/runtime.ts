import { pathToFileURL } from "node:url";
import * as vscode from "vscode";

export function buildPreviewSyncInjectedPageScript(): string {
  return String.raw`(() => {
  const SHELL_SOURCE = "byrdocs-preview-shell";
  const PAGE_SOURCE = "byrdocs-preview-page";
  const BLOCK_ATTRIBUTE = "data-byrdocs-preview-block-id";
  const blockState = {
    blocks: [],
    candidates: [],
    mappings: [],
    position: null,
    targetPathname: null,
    initialized: false,
  };

  const kindPriority = {
    audio: 90,
    blank: 110,
    blockquote: 58,
    choiceOption: 105,
    choices: 82,
    code: 48,
    figure: 90,
    heading: 76,
    listItem: 72,
    math: 66,
    paragraph: 60,
    slot: 112,
    solution: 84,
    table: 50,
  };

  function normalizeText(value) {
    return String(value || "")
      .replace(/<[^>]+>/gu, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/[*_~#>|()[\]{}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
  }

  function normalizePathname(value) {
    let normalized = String(value || "");
    try {
      normalized = decodeURIComponent(normalized);
    } catch {}
    normalized = normalized.replace(/\/+$/gu, "");
    return normalized || "/";
  }

  function isTargetPage() {
    if (typeof blockState.targetPathname !== "string") {
      return false;
    }
    const currentPath = normalizePathname(window.location.pathname);
    const targetPath = normalizePathname(blockState.targetPathname);
    return currentPath === targetPath || currentPath.endsWith(targetPath);
  }

  function getRoot() {
    return (
      document.querySelector(".exam-page-main") ||
      document.querySelector(".wiki-content") ||
      document.body
    );
  }

  function compareNodeOrder(left, right) {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function fileNameFromUrl(urlLike) {
    try {
      const url = new URL(urlLike, window.location.href);
      const pathname = decodeURIComponent(url.pathname || "");
      return pathname.split("/").filter(Boolean).pop() || "";
    } catch {
      return "";
    }
  }

  function readElementText(element) {
    return normalizeText(element.textContent || "");
  }

  function getCandidateKind(element) {
    if (element.matches("h2, h3, h4, h5, h6")) return "heading";
    if (element.matches("figure[data-exam-figure]")) return "figure";
    if (element.matches("figure.exam-audio")) return "audio";
    if (element.matches("fieldset.exam-choices")) return "choices";
    if (element.matches("label.exam-choice-option")) return "choiceOption";
    if (element.matches("details.exam-solution")) return "solution";
    if (element.matches(".exam-blank")) return "blank";
    if (element.matches(".exam-slot")) return "slot";
    if (element.matches("blockquote")) return "blockquote";
    if (element.matches(".katex-display")) return "math";
    if (element.matches("table")) return "table";
    if (element.matches(".code-block-wrapper, pre")) return "code";
    if (element.matches("ol > li, ul > li")) return "listItem";
    if (element.matches("p")) return "paragraph";
    return null;
  }

  function shouldKeepCandidate(element) {
    if (!(element instanceof HTMLElement)) return false;
    const kind = getCandidateKind(element);
    if (!kind) return false;
    if (element.closest("aside")) {
      return false;
    }
    if (
      kind === "paragraph" &&
      element.closest("figure[data-exam-figure], figure.exam-audio, label.exam-choice-option")
    ) {
      return false;
    }
    if (kind === "code" && element.classList.contains("astro-code")) {
      const wrapper = element.parentElement;
      if (wrapper && wrapper.classList.contains("code-block-wrapper")) {
        return false;
      }
    }
    return true;
  }

  function getCandidateSignature(element, kind, kindIndex) {
    if (kind === "figure") {
      return normalizeText(element.getAttribute("data-exam-figure-src") || "");
    }
    if (kind === "audio") {
      const audio = element.querySelector("audio");
      return normalizeText(fileNameFromUrl(audio?.getAttribute("src") || ""));
    }
    if (kind === "choiceOption") {
      const content = element.querySelector(".exam-choice-content");
      return readElementText(content || element);
    }
    if (kind === "choices") {
      const item = element.querySelector(".exam-choices-item");
      return readElementText(item || element);
    }
    if (kind === "slot") {
      return readElementText(element);
    }
    if (kind === "blank") {
      const answer = element.querySelector(".exam-blank-answer");
      return readElementText(answer || element);
    }
    if (kind === "solution") {
      return "solution:" + kindIndex;
    }
    if (kind === "math") {
      return "math:" + kindIndex;
    }
    return readElementText(element);
  }

  function collectCandidates() {
    const root = getRoot();
    const elements = [
      ...root.querySelectorAll(
        [
          "h2, h3, h4, h5, h6",
          "figure[data-exam-figure]",
          "figure.exam-audio",
          "fieldset.exam-choices",
          "label.exam-choice-option",
          "details.exam-solution",
          ".exam-blank",
          ".exam-slot",
          ".katex-display",
          "p",
          "ol > li",
          "ul > li",
          "blockquote",
          "table",
          ".code-block-wrapper",
          "pre",
        ].join(", "),
      ),
    ].filter(shouldKeepCandidate);

    elements.sort(compareNodeOrder);
    const kindCounts = new Map();
    return elements.map((element, index) => {
      const kind = getCandidateKind(element);
      const kindIndex = kind ? kindCounts.get(kind) || 0 : 0;
      if (kind) {
        kindCounts.set(kind, kindIndex + 1);
      }
      return {
        element,
        index,
        kind,
        signature: getCandidateSignature(element, kind, kindIndex),
        text: readElementText(element),
      };
    });
  }

  function isCompatible(block, candidate) {
    if (block.kind === candidate.kind) return true;
    return false;
  }

  function getMatchWeight(block, candidate) {
    if (!candidate.kind || !isCompatible(block, candidate)) {
      return Number.NEGATIVE_INFINITY;
    }
    let weight = 10;
    if (block.signature && candidate.signature) {
      if (block.signature === candidate.signature) weight += 12;
      else if (
        candidate.signature.includes(block.signature) ||
        block.signature.includes(candidate.signature)
      ) {
        weight += 6;
      }
    }
    if (block.text && candidate.text) {
      if (block.text === candidate.text) weight += 4;
      else if (
        candidate.text.includes(block.text) ||
        block.text.includes(candidate.text)
      ) {
        weight += 2;
      }
    }
    return weight;
  }

  function clearMappings() {
    blockState.mappings.forEach((mapping) => {
      mapping.element.removeAttribute(BLOCK_ATTRIBUTE);
    });
    blockState.mappings = [];
  }

  function applyMapping(block, candidate) {
    candidate.element.setAttribute(BLOCK_ATTRIBUTE, block.id);
    blockState.mappings.push({
      block,
      element: candidate.element,
    });
  }

  function collectHeadingIndices(items) {
    const indices = [];
    items.forEach((item, index) => {
      if (item.kind === "heading") {
        indices.push(index);
      }
    });
    return indices;
  }

  function buildMappingSections() {
    const blockHeadingIndices = collectHeadingIndices(blockState.blocks);
    const candidateHeadingIndices = collectHeadingIndices(blockState.candidates);
    const headingCount = Math.min(
      blockHeadingIndices.length,
      candidateHeadingIndices.length,
    );
    if (headingCount === 0) {
      return [
        {
          blockEnd: blockState.blocks.length,
          blockStart: 0,
          candidateEnd: blockState.candidates.length,
          candidateStart: 0,
        },
      ];
    }

    const sections = [];
    if (
      blockHeadingIndices[0] > 0 ||
      candidateHeadingIndices[0] > 0
    ) {
      sections.push({
        blockEnd: blockHeadingIndices[0],
        blockStart: 0,
        candidateEnd: candidateHeadingIndices[0],
        candidateStart: 0,
      });
    }

    for (let index = 0; index < headingCount; index += 1) {
      sections.push({
        blockEnd:
          index + 1 < headingCount
            ? blockHeadingIndices[index + 1]
            : blockState.blocks.length,
        blockStart: blockHeadingIndices[index],
        candidateEnd:
          index + 1 < headingCount
            ? candidateHeadingIndices[index + 1]
            : blockState.candidates.length,
        candidateStart: candidateHeadingIndices[index],
        headingBlockIndex: blockHeadingIndices[index],
        headingCandidateIndex: candidateHeadingIndices[index],
      });
    }

    return sections;
  }

  function buildSectionMatches(blockStart, blockEnd, candidateStart, candidateEnd) {
    const blockCount = blockEnd - blockStart;
    const candidateCount = candidateEnd - candidateStart;
    if (blockCount <= 0 || candidateCount <= 0) {
      return [];
    }

    const columnCount = candidateCount + 1;
    const scores = new Array((blockCount + 1) * columnCount).fill(0);
    const moves = new Uint8Array((blockCount + 1) * columnCount);

    for (let blockOffset = 1; blockOffset <= blockCount; blockOffset += 1) {
      for (
        let candidateOffset = 1;
        candidateOffset <= candidateCount;
        candidateOffset += 1
      ) {
        const cellIndex = blockOffset * columnCount + candidateOffset;
        const upIndex = cellIndex - columnCount;
        const leftIndex = cellIndex - 1;
        const block = blockState.blocks[blockStart + blockOffset - 1];
        const candidate =
          blockState.candidates[candidateStart + candidateOffset - 1];

        let bestScore = scores[upIndex];
        let bestMove = 1;

        if (scores[leftIndex] > bestScore) {
          bestScore = scores[leftIndex];
          bestMove = 2;
        }

        const matchWeight = getMatchWeight(block, candidate);
        if (Number.isFinite(matchWeight)) {
          const diagonalScore = scores[upIndex - 1] + matchWeight;
          if (diagonalScore >= bestScore) {
            bestScore = diagonalScore;
            bestMove = 3;
          }
        }

        scores[cellIndex] = bestScore;
        moves[cellIndex] = bestMove;
      }
    }

    const matches = [];
    let blockOffset = blockCount;
    let candidateOffset = candidateCount;
    while (blockOffset > 0 && candidateOffset > 0) {
      const cellIndex = blockOffset * columnCount + candidateOffset;
      const move = moves[cellIndex];
      if (move === 3) {
        matches.push({
          blockIndex: blockStart + blockOffset - 1,
          candidateIndex: candidateStart + candidateOffset - 1,
        });
        blockOffset -= 1;
        candidateOffset -= 1;
        continue;
      }
      if (move === 2) {
        candidateOffset -= 1;
        continue;
      }
      blockOffset -= 1;
    }

    matches.reverse();
    return matches;
  }

  function applyBlocks(blocks) {
    blockState.blocks = Array.isArray(blocks) ? blocks : [];
    blockState.candidates = collectCandidates();
    clearMappings();

    const sections = buildMappingSections();
    for (const section of sections) {
      if (
        typeof section.headingBlockIndex === "number" &&
        typeof section.headingCandidateIndex === "number"
      ) {
        const headingBlock = blockState.blocks[section.headingBlockIndex];
        const headingCandidate =
          blockState.candidates[section.headingCandidateIndex];
        if (headingBlock && headingCandidate) {
          applyMapping(headingBlock, headingCandidate);
        }
      }

      const blockStart =
        typeof section.headingBlockIndex === "number"
          ? section.headingBlockIndex + 1
          : section.blockStart;
      const candidateStart =
        typeof section.headingCandidateIndex === "number"
          ? section.headingCandidateIndex + 1
          : section.candidateStart;
      const matches = buildSectionMatches(
        blockStart,
        section.blockEnd,
        candidateStart,
        section.candidateEnd,
      );
      for (const match of matches) {
        const block = blockState.blocks[match.blockIndex];
        const candidate = blockState.candidates[match.candidateIndex];
        if (!block || !candidate) {
          continue;
        }
        applyMapping(block, candidate);
      }
    }

    if (blockState.position) {
      revealPosition(blockState.position, { smooth: false });
    }
  }

  function isPositionWithinBlock(block, position) {
    if (position.line < block.startLine || position.line > block.endLine) {
      return false;
    }
    if (
      position.line === block.startLine &&
      position.character < block.startCharacter
    ) {
      return false;
    }
    if (
      position.line === block.endLine &&
      position.character > block.endCharacter
    ) {
      return false;
    }
    return true;
  }

  function compareBlockSpecificity(left, right, position) {
    const leftSpan =
      (left.block.endLine - left.block.startLine) * 10_000 +
      (left.block.endCharacter - left.block.startCharacter);
    const rightSpan =
      (right.block.endLine - right.block.startLine) * 10_000 +
      (right.block.endCharacter - right.block.startCharacter);

    if (leftSpan !== rightSpan) return leftSpan - rightSpan;
    const leftDistance = Math.abs(position.character - left.block.startCharacter);
    const rightDistance = Math.abs(position.character - right.block.startCharacter);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return (right.block.priority || 0) - (left.block.priority || 0);
  }

  function findBestMappingForPosition(position) {
    const containing = blockState.mappings.filter((mapping) =>
      isPositionWithinBlock(mapping.block, position),
    );
    if (containing.length > 0) {
      containing.sort((left, right) =>
        compareBlockSpecificity(left, right, position),
      );
      return containing[0] || null;
    }

    const ranked = blockState.mappings
      .map((mapping) => {
        const before =
          position.line < mapping.block.startLine
            ? mapping.block.startLine - position.line
            : position.line - mapping.block.endLine;
        return {
          distance: before,
          mapping,
        };
      })
      .sort((left, right) => {
        if (left.distance !== right.distance) return left.distance - right.distance;
        return (right.mapping.block.priority || 0) - (left.mapping.block.priority || 0);
      });

    return ranked[0]?.mapping || null;
  }

  function ensureOpenAncestors(element) {
    if (element instanceof HTMLDetailsElement) {
      element.open = true;
    }
    let current = element.parentElement;
    while (current) {
      if (current instanceof HTMLDetailsElement) current.open = true;
      current = current.parentElement;
    }
  }

  function revealPosition(position, options = { smooth: true }) {
    blockState.position = position;
    const mapping = findBestMappingForPosition(position);
    if (!mapping) return;
    ensureOpenAncestors(mapping.element);
    mapping.element.scrollIntoView({
      behavior: options.smooth === false ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    });
  }

  function postReady() {
    window.parent.postMessage(
      {
        isTargetPage: isTargetPage(),
        source: PAGE_SOURCE,
        type: "byrdocsPreviewSync:ready",
      },
      "*",
    );
  }

  function postOpenSourceLocation(block) {
    window.parent.postMessage(
      {
        isTargetPage: isTargetPage(),
        source: PAGE_SOURCE,
        type: "byrdocsPreviewSync:openSourceLocation",
        position: {
          character: block.startCharacter || 0,
          line: block.startLine || 0,
        },
      },
      "*",
    );
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== SHELL_SOURCE) {
      return;
    }

    if (data.type === "byrdocsPreviewSync:setState") {
      blockState.targetPathname =
        typeof data.targetPathname === "string" ? data.targetPathname : null;
      if (!isTargetPage()) {
        clearMappings();
        return;
      }
      applyBlocks(data.blocks || []);
      if (data.position) revealPosition(data.position, { smooth: false });
      return;
    }

    if (data.type === "byrdocsPreviewSync:revealPosition" && data.position) {
      revealPosition(data.position, { smooth: true });
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      const element = path.find(
        (candidate) =>
          candidate instanceof HTMLElement &&
          candidate.hasAttribute &&
          candidate.hasAttribute(BLOCK_ATTRIBUTE),
      );
      if (!(element instanceof HTMLElement)) {
        return;
      }

      if (!isTargetPage()) {
        return;
      }

      const mapping = blockState.mappings.find(
        (item) => item.element === element,
      );
      if (!mapping) {
        return;
      }

      postOpenSourceLocation(mapping.block);
    },
    true,
  );

  const initialize = () => {
    if (blockState.initialized) return;
    blockState.initialized = true;
    postReady();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }

  window.addEventListener("pageshow", postReady);
})();`;
}

export function buildPreviewSyncVitePluginSource(
  injectedPageScriptSource: string,
): string {
  return `const INJECTED_PAGE_SCRIPT = ${JSON.stringify(injectedPageScriptSource)};

function isLikelyHtmlRequest(requestUrl) {
  if (!requestUrl) {
    return false;
  }

  const pathname = requestUrl.split("?")[0] || "";
  if (!pathname || pathname === "/" || pathname.endsWith(".html")) {
    return true;
  }

  return !/\\.[A-Za-z0-9]+$/.test(pathname);
}

function injectScript(html) {
  if (html.includes("/__byrdocs_preview_sync.js")) {
    return html;
  }

  const tag = '<script type="module" src="/__byrdocs_preview_sync.js"></script>';
  if (html.includes("</head>")) {
    return html.replace("</head>", tag + "</head>");
  }

  if (html.includes("</body>")) {
    return html.replace("</body>", tag + "</body>");
  }

  return html + tag;
}

function toBuffer(chunk, encoding) {
  if (chunk == null) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
}

export default function byrdocsPreviewSyncPlugin() {
  return {
    name: "byrdocs-preview-sync",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url || "/";
        if (requestUrl.startsWith("/__byrdocs_preview_sync.js")) {
          response.statusCode = 200;
          response.setHeader(
            "content-type",
            "application/javascript; charset=utf-8",
          );
          response.end(INJECTED_PAGE_SCRIPT);
          return;
        }

        if (request.method !== "GET" || !isLikelyHtmlRequest(requestUrl)) {
          next();
          return;
        }

        const chunks = [];
        const originalWrite = response.write.bind(response);
        const originalEnd = response.end.bind(response);

        response.write = function patchedWrite(chunk, encoding, callback) {
          chunks.push(toBuffer(chunk, encoding));
          if (typeof callback === "function") {
            callback();
          }
          return true;
        };

        response.end = function patchedEnd(chunk, encoding, callback) {
          if (chunk != null) {
            chunks.push(toBuffer(chunk, encoding));
          }

          const contentType = String(response.getHeader("content-type") || "");
          if (contentType.includes("text/html")) {
            const html = Buffer.concat(chunks).toString("utf8");
            const injected = injectScript(html);
            originalEnd(injected, "utf8", callback);
            return;
          }

          if (chunks.length > 0) {
            originalEnd(Buffer.concat(chunks), callback);
            return;
          }

          originalEnd(chunk, encoding, callback);
        };

        next();
      });
    },
  };
}
`;
}

export function buildPreviewSyncAstroConfigSource(
  originalConfigPath: string,
  pluginPath: string,
): string {
  return `import originalConfig from ${JSON.stringify(
    pathToFileURL(originalConfigPath).href,
  )};
import byrdocsPreviewSyncPlugin from ${JSON.stringify(
    pathToFileURL(pluginPath).href,
  )};

const config = originalConfig || {};
const viteConfig = config.vite || {};
const devToolbarConfig =
  config.devToolbar && typeof config.devToolbar === "object"
    ? config.devToolbar
    : {};
const vitePlugins = Array.isArray(viteConfig.plugins)
  ? viteConfig.plugins
  : viteConfig.plugins
    ? [viteConfig.plugins]
    : [];

export default {
  ...config,
  devToolbar: {
    ...devToolbarConfig,
    enabled: false,
  },
  vite: {
    ...viteConfig,
    plugins: [...vitePlugins, byrdocsPreviewSyncPlugin()],
  },
};
`;
}

export function findAstroConfigPath(
  workspaceFolder: vscode.WorkspaceFolder,
  fsExists: (filePath: string) => boolean,
): string | null {
  const candidates = [
    "astro.config.mts",
    "astro.config.ts",
    "astro.config.mjs",
    "astro.config.js",
  ];

  for (const candidate of candidates) {
    const candidatePath = vscode.Uri.joinPath(
      workspaceFolder.uri,
      candidate,
    ).fsPath;
    if (fsExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}
