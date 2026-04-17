import {
  COMPONENTS,
  COMPONENT_NAMES,
  type ComponentName,
} from "./metadata";

export interface IgnoredRange {
  readonly start: number;
  readonly end: number;
}

export interface ParsedAttribute {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly value: string | null;
}

export interface ParsedTag {
  readonly attributes: readonly ParsedAttribute[];
  readonly end: number;
  readonly isClosing: boolean;
  readonly name: ComponentName;
  readonly nameEnd: number;
  readonly nameStart: number;
  readonly selfClosing: boolean;
  readonly start: number;
}

export interface TagPair {
  readonly name: ComponentName;
  readonly open: ParsedTag;
  readonly close: ParsedTag;
}

export interface ChoiceMarker {
  readonly end: number;
  readonly lineEnd: number;
  readonly lineStart: number;
  readonly marker: "+" | "-";
  readonly start: number;
}

export interface ParsedDocumentSyntax {
  readonly choiceMarkers: readonly ChoiceMarker[];
  readonly ignoredRanges: readonly IgnoredRange[];
  readonly pairs: readonly TagPair[];
  readonly tags: readonly ParsedTag[];
}

const COMPONENT_PATTERN = COMPONENT_NAMES.join("|");
const TAG_REGEX = new RegExp(
  `<(\\/?)(${COMPONENT_PATTERN})\\b([\\s\\S]*?)(\\/?)>`,
  "g",
);
const ATTRIBUTE_REGEX =
  /([A-Za-z][\w-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s"'=<>`]+))?/g;

export function parseDocumentSyntax(text: string): ParsedDocumentSyntax {
  const ignoredRanges = computeIgnoredRanges(text);
  const tags: ParsedTag[] = [];

  let match: RegExpExecArray | null;
  while ((match = TAG_REGEX.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (isOffsetIgnored(start, ignoredRanges)) {
      continue;
    }

    const isClosing = match[1] === "/";
    const name = match[2] as ComponentName;
    const selfClosing = match[4] === "/";
    const nameStart = start + 1 + (isClosing ? 1 : 0);
    const nameEnd = nameStart + name.length;
    const attributes: ParsedAttribute[] = [];

    if (!isClosing) {
      const attrSource = match[3] || "";
      const attrBase = nameEnd;
      ATTRIBUTE_REGEX.lastIndex = 0;

      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = ATTRIBUTE_REGEX.exec(attrSource))) {
        const attrName = attrMatch[1];
        if (!attrName) {
          continue;
        }

        const attrStart = attrBase + attrMatch.index;
        const attrEnd = attrStart + attrName.length;

        attributes.push({
          start: attrStart,
          end: attrEnd,
          name: attrName,
          value: readAttributeValue(attrMatch[0]),
        });
      }
    }

    tags.push({
      attributes,
      end,
      isClosing,
      name,
      nameEnd,
      nameStart,
      selfClosing,
      start,
    });
  }

  const pairs = pairTags(tags);
  const choiceMarkers = collectChoiceMarkers(text, pairs, ignoredRanges);

  return {
    choiceMarkers,
    ignoredRanges,
    pairs,
    tags,
  };
}

function computeIgnoredRanges(text: string): IgnoredRange[] {
  const ranges: IgnoredRange[] = [];
  const frontmatterMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (frontmatterMatch) {
    ranges.push({
      start: 0,
      end: frontmatterMatch[0].length,
    });
  }

  const fenceRegex = /^```.*$/gm;
  const fenceMatches: IgnoredRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text))) {
    fenceMatches.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  for (let index = 0; index + 1 < fenceMatches.length; index += 2) {
    const start = fenceMatches[index];
    const end = fenceMatches[index + 1];
    if (!start || !end) {
      continue;
    }

    ranges.push({
      start: start.start,
      end: end.end,
    });
  }

  return ranges.sort((left, right) => left.start - right.start);
}

export function isOffsetIgnored(
  offset: number,
  ignoredRanges: readonly IgnoredRange[],
): boolean {
  return ignoredRanges.some(
    (range) => offset >= range.start && offset <= range.end,
  );
}

function pairTags(tags: readonly ParsedTag[]): TagPair[] {
  const stack: ParsedTag[] = [];
  const pairs: TagPair[] = [];

  for (const tag of tags) {
    const metadata = COMPONENTS[tag.name];

    if (tag.isClosing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.name !== tag.name) {
          continue;
        }

        const open = stack.splice(index, 1)[0];
        if (open) {
          pairs.push({
            name: tag.name,
            open,
            close: tag,
          });
        }
        break;
      }
      continue;
    }

    if (tag.selfClosing || metadata.kind === "selfClosing") {
      continue;
    }

    stack.push(tag);
  }

  return pairs.sort((left, right) => left.open.start - right.open.start);
}

function collectChoiceMarkers(
  text: string,
  pairs: readonly TagPair[],
  ignoredRanges: readonly IgnoredRange[],
): ChoiceMarker[] {
  const markers: ChoiceMarker[] = [];
  const blocks = pairs.filter((pair) => pair.name === "Choices");

  for (const block of blocks) {
    const contentStart = block.open.end;
    const contentEnd = block.close.start;
    const content = text.slice(contentStart, contentEnd);
    const markerRegex = /^[ \t]*([+-])(?=\s+)/gm;
    let match: RegExpExecArray | null;

    while ((match = markerRegex.exec(content))) {
      const marker = match[1] as "+" | "-";
      const markerStart =
        contentStart + match.index + match[0].lastIndexOf(marker);

      if (isOffsetIgnored(markerStart, ignoredRanges)) {
        continue;
      }

      const lineEndRelative = content.indexOf("\n", match.index);
      const lineEnd =
        lineEndRelative === -1 ? contentEnd : contentStart + lineEndRelative;
      const lineStartRelative = content.lastIndexOf("\n", match.index);

      markers.push({
        end: markerStart + 1,
        lineEnd,
        lineStart:
          lineStartRelative === -1
            ? contentStart
            : contentStart + lineStartRelative + 1,
        marker,
        start: markerStart,
      });
    }
  }

  return markers;
}

function readAttributeValue(sourceText: string): string | null {
  const equalsIndex = sourceText.indexOf("=");
  if (equalsIndex < 0) {
    return null;
  }

  const rawValue = sourceText.slice(equalsIndex + 1).trim();
  if (!rawValue) {
    return "";
  }

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }

  if (rawValue.startsWith("{") && rawValue.endsWith("}")) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

export function findTagAtOffset(
  tags: readonly ParsedTag[],
  offset: number,
): ParsedTag | null {
  return tags.find((tag) => offset >= tag.start && offset <= tag.end) || null;
}

export function findTagNameAtOffset(
  tags: readonly ParsedTag[],
  offset: number,
): ParsedTag | null {
  return (
    tags.find((tag) => offset >= tag.nameStart && offset <= tag.nameEnd) || null
  );
}

export function findAttributeAtOffset(
  tag: ParsedTag | null,
  offset: number,
): ParsedAttribute | null {
  if (!tag || tag.isClosing) {
    return null;
  }

  return (
    tag.attributes.find(
      (attribute) => offset >= attribute.start && offset <= attribute.end,
    ) || null
  );
}

export function findChoiceMarkerAtOffset(
  choiceMarkers: readonly ChoiceMarker[],
  offset: number,
): ChoiceMarker | null {
  return (
    choiceMarkers.find(
      (marker) => offset >= marker.start && offset <= marker.end,
    ) || null
  );
}

export function getOpenComponentStack(
  tags: readonly ParsedTag[],
  offset: number,
): ParsedTag[] {
  const stack: ParsedTag[] = [];

  for (const tag of tags) {
    if (tag.start >= offset) {
      break;
    }

    const metadata = COMPONENTS[tag.name];
    if (tag.isClosing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.name === tag.name) {
          stack.splice(index, 1);
          break;
        }
      }
      continue;
    }

    if (tag.selfClosing || metadata.kind === "selfClosing") {
      continue;
    }

    stack.push(tag);
  }

  return stack;
}

export function getEnclosingChoicesBlock(
  pairs: readonly TagPair[],
  offset: number,
): TagPair | null {
  return (
    pairs.find(
      (pair) =>
        pair.name === "Choices" &&
        offset >= pair.open.end &&
        offset <= pair.close.start,
    ) || null
  );
}
