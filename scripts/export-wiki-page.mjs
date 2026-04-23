import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
    fetchExamPage,
    fetchFileDownloadInfo,
    getAuthHeaders,
    getPageContent,
} from "./lib/wiki.mjs";

const SCHOOL_NAMES = [
    "人工智能学院",
    "人文学院",
    "信息与通信工程学院",
    "卓越工程师学院",
    "国际学院",
    "数字媒体与设计艺术学院",
    "数学科学学院",
    "智能工程与自动化学院",
    "未来学院",
    "物理科学与技术学院",
    "玛丽女王海南学院",
    "理学院",
    "电子工程学院",
    "经济管理学院",
    "网络空间安全学院",
    "计算机学院",
    "集成电路学院",
    "马克思主义学院",
];

const SCHOOL_SET = new Set(SCHOOL_NAMES);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
const BLOCK_TOKEN_PATTERN = /^(?:[-*] |\d+\. )?@@BYR_BLOCK_(\d+)@@$/;
const BLANK_TOKEN = "@@BYR_BLANK@@";
const PARAM_TOKEN = "@@BYR_PARAM@@";

function parseArgs(argv) {
    const options = {
        outputDir: "exams",
        overwrite: false,
        stdout: false,
        skipAssets: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--overwrite") {
            options.overwrite = true;
            continue;
        }

        if (arg === "--stdout") {
            options.stdout = true;
            continue;
        }

        if (arg === "--skip-assets") {
            options.skipAssets = true;
            continue;
        }

        if (arg === "--title" && argv[index + 1]) {
            options.title = argv[index + 1];
            index += 1;
            continue;
        }

        if (arg.startsWith("--title=")) {
            options.title = arg.slice("--title=".length);
            continue;
        }

        if (arg === "--output-dir" && argv[index + 1]) {
            options.outputDir = argv[index + 1];
            index += 1;
            continue;
        }

        if (arg.startsWith("--output-dir=")) {
            options.outputDir = arg.slice("--output-dir=".length);
            continue;
        }

        if (!arg.startsWith("-")) {
            if (options.title)
                throw new Error(`只能提供一个页面标题，重复参数：${arg}`);
            options.title = arg;
            continue;
        }

        throw new Error(`未知参数：${arg}`);
    }

    if (!options.title)
        throw new Error("必须提供旧 wiki 页面标题。用法：node scripts/export-wiki-page.mjs <页面标题> [选项]");

    return options;
}

function canonicalizeTemplateName(name) {
    return name
        .trim()
        .replace(/^template:/i, "")
        .replace(/^subst:/i, "")
        .replace(/^safesubst:/i, "")
        .replace(/_/g, " ")
        .toLowerCase();
}

function splitTopLevel(text, separator = "|") {
    const parts = [];
    let current = "";
    let templateDepth = 0;
    let parameterDepth = 0;
    let linkDepth = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text.startsWith("{{{", index)) {
            parameterDepth += 1;
            current += "{{{";
            index += 2;
            continue;
        }

        if (text.startsWith("}}}", index) && parameterDepth > 0) {
            parameterDepth -= 1;
            current += "}}}";
            index += 2;
            continue;
        }

        if (parameterDepth === 0 && text.startsWith("{{", index)) {
            templateDepth += 1;
            current += "{{";
            index += 1;
            continue;
        }

        if (parameterDepth === 0 && text.startsWith("}}", index) && templateDepth > 0) {
            templateDepth -= 1;
            current += "}}";
            index += 1;
            continue;
        }

        if (parameterDepth === 0 && text.startsWith("[[", index)) {
            linkDepth += 1;
            current += "[[";
            index += 1;
            continue;
        }

        if (parameterDepth === 0 && text.startsWith("]]", index) && linkDepth > 0) {
            linkDepth -= 1;
            current += "]]";
            index += 1;
            continue;
        }

        const char = text[index];
        if (char === separator && templateDepth === 0 && parameterDepth === 0 && linkDepth === 0) {
            parts.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    parts.push(current);
    return parts;
}

function readBalanced(text, start, open, close) {
    let depth = 1;

    for (let index = start + open.length; index < text.length; index += 1) {
        if (open === "{{" && text.startsWith("{{{", index)) {
            const parameter = readBalanced(text, index, "{{{", "}}}");
            index = parameter.end - 1;
            continue;
        }

        if (text.startsWith(open, index)) {
            depth += 1;
            index += open.length - 1;
            continue;
        }

        if (text.startsWith(close, index)) {
            depth -= 1;
            if (depth === 0) {
                return {
                    raw: text.slice(start, index + close.length),
                    inner: text.slice(start + open.length, index),
                    end: index + close.length,
                };
            }
            index += close.length - 1;
        }
    }

    return {
        raw: text.slice(start),
        inner: text.slice(start + open.length),
        end: text.length,
    };
}

function extractCodeBlocks(text) {
    const codeBlocks = [];
    const extracted = text.replace(
        /<syntaxhighlight(?:\s+lang="([^"]+)")?[^>]*>([\s\S]*?)<\/syntaxhighlight>/gi,
        (_match, lang = "text", content = "") => {
            const fence = [
                `\`\`\`${String(lang).trim() || "text"}`,
                String(content).replace(/^\n+|\n+$/g, ""),
                "```",
            ].join("\n");
            const token = `@@BYR_CODE_${codeBlocks.length}@@`;
            codeBlocks.push(fence);
            return token;
        },
    );

    return {
        text: extracted,
        restore(converted) {
            return converted.replace(/@@BYR_CODE_(\d+)@@/g, (_match, id) => codeBlocks[Number(id)] ?? "");
        },
    };
}

function normalizeNamedArgument(param) {
    const match = param.match(/^\s*1\s*=\s*([\s\S]*)$/);
    return match ? match[1] : param;
}

function parseNamedParams(params) {
    const result = {};

    for (const param of params) {
        const match = param.match(/^\s*([^=\n]+?)\s*=\s*([\s\S]*)$/);
        if (!match)
            continue;

        result[match[1].trim()] = match[2].trim();
    }

    return result;
}

function splitSchools(value) {
    return [...new Set(
        value
            .split(/[\s\n]+/)
            .map(item => item.trim())
            .filter(item => SCHOOL_SET.has(item)),
    )];
}

function inferFromTitle(title) {
    const match = title.match(/^(\d{2})-(\d{2})-([12])-(.+)-(期中|期末)(?:（.+）)?$/);
    if (!match)
        return {};

    const [, start, end, semester, subject, stage] = match;
    return {
        时间: `20${start}-20${end}学年第${semester === "1" ? "一" : "二"}学期`,
        科目: subject,
        阶段: stage,
    };
}

function inferMetadata(page, infoboxData) {
    const titleMetadata = inferFromTitle(page.title);
    const categories = Array.isArray(page.categories)
        ? page.categories
            .map(item => item.title.replace(/^分类:/, "").trim())
            .filter(Boolean)
        : [];

    const metadata = {
        时间: infoboxData.时间 || titleMetadata.时间,
        科目: infoboxData.科目 || titleMetadata.科目,
        阶段: infoboxData.阶段 || titleMetadata.阶段,
        类型: infoboxData.类型,
    };

    if (!metadata.类型) {
        if (categories.includes("研究生试卷"))
            metadata.类型 = "研究生";
        else if (categories.includes("本科试卷"))
            metadata.类型 = "本科";
    }

    const schools = splitSchools(infoboxData.学院 || categories.join(" "));
    if (schools.length > 0)
        metadata.学院 = schools;

    if (infoboxData.来源 && /^[0-9a-f]{32}$/.test(infoboxData.来源))
        metadata.来源 = infoboxData.来源;

    if (infoboxData.答案完成度)
        metadata.答案完成度 = infoboxData.答案完成度;
    else if (categories.includes("有完整可靠答案"))
        metadata.答案完成度 = "完整可靠";
    else if (categories.includes("有完整答案"))
        metadata.答案完成度 = "完整";
    else if (categories.some(item => item.includes("部分答案") || item.includes("残缺答案")))
        metadata.答案完成度 = "残缺";

    if (!metadata.类型)
        metadata.类型 = "本科";

    return metadata;
}

function renderFrontmatter(metadata) {
    const lines = ["---"];
    const orderedKeys = ["时间", "科目", "阶段", "类型"];

    for (const key of orderedKeys) {
        if (metadata[key])
            lines.push(`${key}: ${metadata[key]}`);
    }

    if (Array.isArray(metadata.学院) && metadata.学院.length > 0) {
        lines.push("学院:");
        for (const school of metadata.学院)
            lines.push(`- ${school}`);
    }

    if (metadata.来源)
        lines.push(`来源: ${metadata.来源}`);
    if (metadata.答案完成度)
        lines.push(`答案完成度: ${metadata.答案完成度}`);

    lines.push("---");
    return `${lines.join("\n")}\n`;
}

function indentBlock(text, spaces = 4) {
    const prefix = " ".repeat(spaces);
    return text
        .split("\n")
        .map(line => line ? `${prefix}${line}` : "")
        .join("\n");
}

function createContext(page) {
    return {
        pageTitle: page.title,
        blocks: [],
        referencedFiles: new Map(),
    };
}

function createBlockToken(context, block) {
    const id = context.blocks.push(block) - 1;
    return `\n\n@@BYR_BLOCK_${id}@@\n\n`;
}

function registerFile(context, fileTitle) {
    const name = basename(fileTitle.replace(/^[^:]+:/, ""));
    context.referencedFiles.set(fileTitle, name);
    return name;
}

function renderFigureComponent(fileName, caption, { float }) {
    const floatAttr = float ? " float" : "";

    if (!caption)
        return `<Figure src="${fileName}"${floatAttr} />`;

    return [
        `<Figure src="${fileName}"${floatAttr}>`,
        indentBlock(caption, 4),
        "</Figure>",
    ].join("\n");
}

function renderAudioComponent(pageTitle, fileName, caption) {
    const source = `/exam/${pageTitle}/${fileName}`;

    if (!caption)
        return `<Audio src="${source}" />`;

    return [
        `<Audio src="${source}">`,
        indentBlock(caption, 4),
        "</Audio>",
    ].join("\n");
}

function parseFileLink(rawLink, context) {
    const parts = splitTopLevel(rawLink, "|").map(item => item.trim()).filter(Boolean);
    const [target, ...options] = parts;
    const fileName = registerFile(context, target);
    const extension = extname(fileName).toLowerCase();
    const isAudio = AUDIO_EXTENSIONS.has(extension);

    let float = false;
    let caption = "";

    for (const option of options) {
        const lower = option.toLowerCase();
        if (["thumb", "thumbnail", "right", "left"].includes(lower)) {
            float = true;
            continue;
        }
        if (["center", "none", "frameless"].includes(lower) || lower.startsWith("alt=") || lower.startsWith("link="))
            continue;
        caption = option;
    }

    const convertedCaption = caption ? convertFragment(caption, context) : "";
    return isAudio
        ? renderAudioComponent(context.pageTitle, fileName, convertedCaption)
        : renderFigureComponent(fileName, convertedCaption, { float });
}

function parseChoiceAnswer(body) {
    const normalized = body
        .replace(/<[^>]+>/g, "")
        .replace(/[\s,，、/]+/g, "")
        .trim()
        .toUpperCase();

    if (!normalized || !/^[A-H]+$/.test(normalized))
        return null;

    return [...new Set([...normalized])];
}

function renderChoices(options, correctAnswers, { item, multiple = false } = {}) {
    const attributes = [];
    if (item)
        attributes.push(`item="${item}"`);
    if (multiple || (Array.isArray(correctAnswers) && correctAnswers.length > 1))
        attributes.push("multiple");

    const optionLines = options.map((option, index) => {
        const optionLetter = String.fromCharCode(65 + index);
        const isCorrect = Array.isArray(correctAnswers) && correctAnswers.includes(optionLetter);
        const trimmed = option.trim();

        if (!trimmed.includes("\n"))
            return `    <Option${isCorrect ? " correct" : ""}>${trimmed}</Option>`;

        return [
            `    <Option${isCorrect ? " correct" : ""}>`,
            indentBlock(trimmed, 8),
            "    </Option>",
        ].join("\n");
    });

    return [
        `<Choices${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`,
        ...optionLines,
        "</Choices>",
    ].join("\n");
}

function renderSolution(body) {
    const trimmed = body.trim();
    return [
        "<Solution>",
        indentBlock(trimmed, 4),
        "</Solution>",
    ].join("\n");
}

function collapseInlineAnswer(body) {
    return body
        .trim()
        .replace(/\s*\n\s*/g, " ");
}

function replaceFirstBlank(block, replacement) {
    return block.replace(new RegExp(`${BLANK_TOKEN}|${PARAM_TOKEN}`), replacement);
}

function replaceAllBlanks(block, replacement) {
    return block.replace(new RegExp(`${BLANK_TOKEN}|${PARAM_TOKEN}`, "g"), replacement);
}

function replaceSequentialBlanks(block, replacements) {
    let index = 0;
    return block.replace(new RegExp(`${BLANK_TOKEN}|${PARAM_TOKEN}`, "g"), () => replacements[index++] ?? "<Blank />");
}

function hasBlank(block) {
    return block.includes(BLANK_TOKEN) || block.includes(PARAM_TOKEN);
}

function countBlanks(block) {
    return [...block.matchAll(new RegExp(`${BLANK_TOKEN}|${PARAM_TOKEN}`, "g"))].length;
}

function splitBlankAnswerParts(body) {
    return body
        .split(/[；;]/)
        .map(item => collapseInlineAnswer(item))
        .filter(Boolean);
}

function splitIntoBlocks(text) {
    const lines = text.trim().split("\n");
    const blocks = [];
    let current = [];
    let inFence = false;

    for (const line of lines) {
        if (line.trim().startsWith("```"))
            inFence = !inFence;

        if (!inFence && line.trim() === "") {
            if (current.length > 0) {
                blocks.push(current.join("\n").trimEnd());
                current = [];
            }
            continue;
        }

        current.push(line);
    }

    if (current.length > 0)
        blocks.push(current.join("\n").trimEnd());

    return blocks;
}

function isBridgeBlock(block) {
    const trimmed = block.trim();
    return trimmed.startsWith("<Figure") || trimmed.startsWith("<Audio");
}

function findNearestHeading(blocks) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const lines = blocks[index].trim().split("\n");
        const headingLine = lines.find(line => /^#{1,6}\s+/.test(line.trim()));
        if (headingLine)
            return headingLine.replace(/^#{1,6}\s+/, "").trim();
    }

    return "";
}

function findAttachableBlankIndex(blocks) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (hasBlank(blocks[index]))
            return index;
        if (isBridgeBlock(blocks[index]))
            continue;
        break;
    }

    return -1;
}

function resolveStructuredBlocks(text, context) {
    const normalized = text.replace(
        /^\s*(?:[-*] |\d+\. )?(@@BYR_BLOCK_\d+@@)\s*$/gm,
        "\n$1\n",
    );
    const blocks = splitIntoBlocks(normalized);
    const output = [];
    let pendingChoiceAnswer = null;

    for (const block of blocks) {
        const tokenMatch = block.trim().match(BLOCK_TOKEN_PATTERN);
        if (!tokenMatch) {
            output.push(block);
            continue;
        }

        const entry = context.blocks[Number(tokenMatch[1])];
        const lastIndex = output.length - 1;
        const lastBlock = lastIndex >= 0 ? output[lastIndex] : "";
        const blankIndex = findAttachableBlankIndex(output);
        const blankBlock = blankIndex >= 0 ? output[blankIndex] : "";

        if (entry.type === "answer") {
            const letters = parseChoiceAnswer(entry.body);
            if (blankIndex >= 0) {
                if (letters) {
                    output[blankIndex] = replaceAllBlanks(blankBlock, "<Slot />");
                    pendingChoiceAnswer = letters;
                } else {
                    const blankCount = countBlanks(blankBlock);
                    const answerParts = splitBlankAnswerParts(entry.body);

                    if (blankCount > 1 && answerParts.length === blankCount) {
                        output[blankIndex] = replaceSequentialBlanks(
                            blankBlock,
                            answerParts.map(part => `<Blank>${part}</Blank>`),
                        );
                    } else {
                        output[blankIndex] = replaceFirstBlank(
                            blankBlock,
                            `<Blank>${collapseInlineAnswer(entry.body)}</Blank>`,
                        );
                    }
                }
            } else if (letters) {
                pendingChoiceAnswer = letters;
            } else {
                output.push(renderSolution(entry.body));
            }
            continue;
        }

        if (entry.type === "choices") {
            let item;
            const standaloneNumberMatch = lastBlock.trim().match(/^(\d+)[.．、]$/);
            if (standaloneNumberMatch)
                item = standaloneNumberMatch[1];

            const currentHeading = findNearestHeading(output);
            const isSectionMultiple = currentHeading.includes("多选");

            if (blankIndex >= 0)
                output[blankIndex] = replaceAllBlanks(blankBlock, "<Slot />");

            output.push(renderChoices(entry.options, pendingChoiceAnswer, {
                item,
                multiple: isSectionMultiple,
            }));
            pendingChoiceAnswer = null;
        }
    }

    return output
        .map(block => replaceAllBlanks(block, "<Blank />"))
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function cleanupMath(text) {
    return text
        .replace(/\\begin\s*\{\s*align\s*\}/g, "\\begin{align*}")
        .replace(/\\end\s*\{\s*align\s*\}/g, "\\end{align*}")
        .replace(/^\s+|\s+$/g, "")
        .replace(/\s*\n\s*/g, " ");
}

function convertInlineFormatting(text) {
    return text
        .replace(/'''''([\s\S]+?)'''''/g, "***$1***")
        .replace(/'''([\s\S]+?)'''/g, "**$1**")
        .replace(/''([\s\S]+?)''/g, "*$1*");
}

function convertPlainTextSegment(text) {
    let converted = text;

    converted = converted.replace(/<u>[\s\S]*?@@BYR_PARAM@@[\s\S]*?<\/u>/gi, BLANK_TOKEN);
    converted = converted.replace(/@@BYR_PARAM@@/g, BLANK_TOKEN);
    converted = converted.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, code) => `\`${String(code).trim()}\``);
    converted = converted.replace(/<math>([\s\S]*?)<\/math>/gi, (_match, math) => `$${cleanupMath(String(math))}$`);
    converted = converted.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)]/g, "[$2]($1)");

    return converted;
}

function convertHeadings(text) {
    return text.replace(/^(={2,6})\s*(.*?)\s*\1\s*$/gm, (_match, marks, title) => {
        const depth = Math.min(marks.length, 6);
        return `${"#".repeat(depth)} ${title.trim()}`;
    });
}

function splitTableCells(line, marker) {
    const content = line.slice(marker.length);
    const separator = marker === "!" ? "!!" : "||";
    return content
        .split(separator)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseCell(spec) {
    const pipeIndex = spec.indexOf("|");
    if (pipeIndex > -1) {
        const attrs = spec.slice(0, pipeIndex).trim();
        const value = spec.slice(pipeIndex + 1).trim();
        if (attrs.includes("="))
            return { attrs, value };
    }

    return { attrs: "", value: spec.trim() };
}

function convertWikiTable(lines) {
    const firstLine = lines[0].replace(/^\{\|/, "").trim();
    const open = `<table${firstLine ? ` ${firstLine}` : ""}>`;
    const html = [open];
    let rowOpen = false;

    const openRow = () => {
        if (!rowOpen) {
            html.push("  <tr>");
            rowOpen = true;
        }
    };

    const closeRow = () => {
        if (rowOpen) {
            html.push("  </tr>");
            rowOpen = false;
        }
    };

    for (const line of lines.slice(1, -1)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;

        if (trimmed.startsWith("|+")) {
            closeRow();
            html.push(`  <caption>${trimmed.slice(2).trim()}</caption>`);
            continue;
        }

        if (trimmed.startsWith("|-")) {
            closeRow();
            continue;
        }

        if (trimmed.startsWith("!")) {
            openRow();
            for (const cell of splitTableCells(trimmed, "!")) {
                const { attrs, value } = parseCell(cell);
                html.push(`    <th${attrs ? ` ${attrs}` : ""}>${value}</th>`);
            }
            continue;
        }

        if (trimmed.startsWith("|")) {
            openRow();
            for (const cell of splitTableCells(trimmed, "|")) {
                const { attrs, value } = parseCell(cell);
                html.push(`    <td${attrs ? ` ${attrs}` : ""}>${value}</td>`);
            }
        }
    }

    closeRow();
    html.push("</table>");
    return html.join("\n");
}

function convertWikiTables(text) {
    const lines = text.split("\n");
    const output = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim().startsWith("{|")) {
            output.push(line);
            continue;
        }

        const tableLines = [line];
        index += 1;
        while (index < lines.length) {
            tableLines.push(lines[index]);
            if (lines[index].trim() === "|}")
                break;
            index += 1;
        }

        output.push(convertWikiTable(tableLines));
    }

    return output.join("\n");
}

function convertListLines(text) {
    return text.replace(/^([:*#]+)\s*(.*)$/gm, (_match, markers, content) => {
        const depth = markers.length;
        const indent = "  ".repeat(depth - 1);
        const lastMarker = markers.at(-1);
        const prefix = lastMarker === "#" ? "1. " : "- ";
        return `${indent}${prefix}${content}`;
    });
}

function normalizeStandaloneMathBlocks(text) {
    return text;
}

function cleanFragment(text) {
    return text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function convertLink(inner, context) {
    const parts = splitTopLevel(inner, "|");
    const target = parts[0]?.trim() ?? "";
    const label = parts[1]?.trim();
    const [namespace] = target.split(":");
    const normalizedNamespace = namespace?.toLowerCase();

    if (["file", "文件", "media", "媒体"].includes(normalizedNamespace))
        return `\n\n${parseFileLink(inner, context)}\n\n`;

    return label || target.replace(/^[^:]+:/, "");
}

function convertTemplate(name, params, context) {
    const normalized = canonicalizeTemplateName(name);

    if (normalized === "blank" || normalized === "填空")
        return BLANK_TOKEN;

    if (normalized === "answer" || normalized === "解答") {
        const body = convertFragment(normalizeNamedArgument(params.join("|")), context);
        return createBlockToken(context, {
            type: "answer",
            body,
        });
    }

    if (normalized === "choices" || normalized === "选项") {
        const options = params.map(option => convertFragment(option, context));
        return createBlockToken(context, {
            type: "choices",
            options,
        });
    }

    if (normalized === "center") {
        const body = convertFragment(normalizeNamedArgument(params.join("|")), context);
        const displayMath = body.match(/^\$([\s\S]+)\$$/);
        if (displayMath)
            return `\n\n$$\n${displayMath[1].trim()}\n$$\n\n`;
        return `\n\n${body}\n\n`;
    }

    if (normalized === "!")
        return "|";
    if (normalized === "=")
        return "=";
    if (normalized === "(")
        return "(";
    if (normalized === ")")
        return ")";
    if (normalized === "(!")
        return "{|";
    if (normalized === "!)")
        return "|}";

    throw new Error(`导出器遇到了未支持的模板：${name}`);
}

function convertRecursive(text, context) {
    let output = "";
    let cursor = 0;

    while (cursor < text.length) {
        if (text.startsWith("{{{", cursor)) {
            const parameter = readBalanced(text, cursor, "{{{", "}}}");
            output += PARAM_TOKEN;
            cursor = parameter.end;
            continue;
        }

        if (text.startsWith("{{", cursor)) {
            const template = readBalanced(text, cursor, "{{", "}}");
            const parts = splitTopLevel(template.inner, "|");
            const [name, ...params] = parts;
            output += convertTemplate(name ?? "", params, context);
            cursor = template.end;
            continue;
        }

        if (text.startsWith("[[", cursor)) {
            const link = readBalanced(text, cursor, "[[", "]]");
            output += convertLink(link.inner, context);
            cursor = link.end;
            continue;
        }

        let next = text.length;
        const nextTemplate = text.indexOf("{{", cursor);
        const nextParameter = text.indexOf("{{{", cursor);
        const nextLink = text.indexOf("[[", cursor);

        for (const candidate of [nextTemplate, nextParameter, nextLink]) {
            if (candidate !== -1 && candidate < next)
                next = candidate;
        }

        output += convertPlainTextSegment(text.slice(cursor, next));
        cursor = next;
    }

    return output;
}

function convertFragment(text, context) {
    const trimmed = text.replace(/^\n+|\n+$/g, "");
    if (!trimmed)
        return "";

    const extracted = extractCodeBlocks(trimmed);
    const converted = convertRecursive(extracted.text, context);
    const withTables = convertWikiTables(converted);
    const withLists = convertListLines(withTables);
    const withHeadings = convertHeadings(withLists);
    const withInlineFormatting = convertInlineFormatting(withHeadings);
    const withMathBlocks = normalizeStandaloneMathBlocks(withInlineFormatting);
    const restored = extracted.restore(withMathBlocks);
    return cleanFragment(restored);
}

function extractInfobox(source) {
    const trimmed = source.trimStart();
    if (!trimmed.startsWith("{{Infobox"))
        return { sourceWithoutInfobox: source, infoboxData: {} };

    const startOffset = source.indexOf(trimmed);
    const template = readBalanced(source, startOffset, "{{", "}}");
    const parts = splitTopLevel(template.inner, "|");
    const [name, ...params] = parts;

    if (canonicalizeTemplateName(name ?? "") !== "infobox")
        return { sourceWithoutInfobox: source, infoboxData: {} };

    const infoboxData = parseNamedParams(params);
    const sourceWithoutInfobox = `${source.slice(0, startOffset)}${source.slice(template.end)}`.replace(/^\s+/, "");

    return { sourceWithoutInfobox, infoboxData };
}

async function downloadAssets(context, examDirectory) {
    let downloadedCount = 0;
    const failures = [];

    for (const [fileTitle, fileName] of context.referencedFiles.entries()) {
        const targetPath = join(examDirectory, fileName);
        if (existsSync(targetPath)) {
            downloadedCount += 1;
            continue;
        }

        try {
            const info = await fetchFileDownloadInfo(fileTitle);
            const response = await fetch(info.url, {
                headers: getAuthHeaders(),
            });

            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);

            const buffer = Buffer.from(await response.arrayBuffer());
            writeFileSync(targetPath, buffer);
            downloadedCount += 1;
        } catch (error) {
            failures.push({
                fileTitle,
                fileName,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { downloadedCount, failures };
}

async function exportPage(page, options) {
    const context = createContext(page);
    const { sourceWithoutInfobox, infoboxData } = extractInfobox(getPageContent(page));
    const metadata = inferMetadata(page, infoboxData);
    const bodyFragment = convertFragment(sourceWithoutInfobox, context);
    const resolvedBody = resolveStructuredBlocks(bodyFragment, context);
    const frontmatter = renderFrontmatter(metadata);
    const mdx = `${frontmatter}\n${resolvedBody}\n`;

    if (options.stdout)
        return { mdx, context };

    const examDirectory = join(options.outputDir, page.title);
    const indexPath = join(examDirectory, "index.mdx");

    if (existsSync(indexPath) && !options.overwrite)
        throw new Error(`目标文件已存在：${indexPath}。如需覆盖，请添加 --overwrite。`);

    mkdirSync(examDirectory, { recursive: true });
    writeFileSync(indexPath, mdx);

    const assetResult = options.skipAssets
        ? { downloadedCount: 0, failures: [] }
        : await downloadAssets(context, examDirectory);

    return { mdx, context, indexPath, assetResult };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const page = await fetchExamPage(options.title);
    const result = await exportPage(page, options);

    if (options.stdout) {
        console.log(result.mdx);
        return;
    }

    console.log(`Exported ${page.title} -> ${result.indexPath}`);
    if (!options.skipAssets)
        console.log(`Downloaded ${result.assetResult.downloadedCount} asset(s).`);
    if (result.assetResult.failures.length > 0) {
        console.warn("Asset download warnings:");
        for (const failure of result.assetResult.failures)
            console.warn(`- ${failure.fileTitle} -> ${failure.fileName}: ${failure.reason}`);
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
