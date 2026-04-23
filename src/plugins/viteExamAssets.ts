import { readdir, readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { statSync, createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { examsDir, getExamDirectories } from "../utils/examDirectories";

const ASSET_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav"]);

const MIME_TYPES: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
};

const STATIC_PAGE_ASSET_DIRECTORIES = {
    guide: resolve("src/guide"),
    test: resolve("src/test"),
} as const;

type AssetDirectory = {
    routePrefix: string;
    fileSystemPath: string;
};

const collectStaticPageAssetDirectories = (): AssetDirectory[] =>
    Object.entries(STATIC_PAGE_ASSET_DIRECTORIES).map(([routePrefix, fileSystemPath]) => ({
        routePrefix,
        fileSystemPath,
    }));

const isStaticRoutePrefix = (value: string): value is keyof typeof STATIC_PAGE_ASSET_DIRECTORIES =>
    value in STATIC_PAGE_ASSET_DIRECTORIES;

const listAssetFiles = async (directoryPath: string) => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => entry.name);
};

const streamAssetFile = (response: ServerResponse, filePath: string, extension: string) => {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;

    response.setHeader("Content-Type", MIME_TYPES[extension] ?? "application/octet-stream");
    response.setHeader("Cache-Control", "no-cache");
    createReadStream(filePath).pipe(response);
    return true;
};

export default function viteExamAssets() {
    let isBuild = false;
    const staticAssetDirectories = collectStaticPageAssetDirectories();

    return {
        name: "exam-assets",
        config(_cfg: unknown, env: { command: string }) {
            isBuild = env.command === "build";
        },
        async buildStart(this: { emitFile(file: { type: "asset"; fileName: string; source: Buffer }): string }) {
            if (!isBuild) return;

            for (const { name, path: examDir } of getExamDirectories()) {
                const files = await listAssetFiles(examDir);
                for (const file of files) {
                    this.emitFile({
                        type: "asset",
                        fileName: `exam/${name}/${file}`,
                        source: await readFile(join(examDir, file)),
                    });
                }
            }

            for (const { routePrefix, fileSystemPath } of staticAssetDirectories) {
                const files = await listAssetFiles(fileSystemPath);
                for (const file of files) {
                    this.emitFile({
                        type: "asset",
                        fileName: `${routePrefix}/${file}`,
                        source: await readFile(join(fileSystemPath, file)),
                    });
                }
            }
        },
        configureServer(server: { middlewares: { use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void } }) {
            server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
                const rawUrl = req.url ?? "";
                const urlPath = rawUrl.split("?")[0];
                let url: string;
                try {
                    url = decodeURIComponent(urlPath);
                } catch {
                    return next();
                }
                const match = url.match(/^\/exam\/([^/]+)\/([^/]+)$/);
                if (match) {
                    const [, examName, filename] = match;
                    const ext = extname(filename).toLowerCase();
                    if (!ASSET_EXTENSIONS.has(ext)) return next();

                    const filePath = join(examsDir, examName, filename);
                    try {
                        if (streamAssetFile(res, filePath, ext)) return;
                    } catch { }
                    return next();
                }

                const staticMatch = url.match(/^\/(guide|test)\/([^/]+)$/);
                if (!staticMatch) return next();

                const [, routePrefix, filename] = staticMatch;
                const ext = extname(filename).toLowerCase();
                if (!ASSET_EXTENSIONS.has(ext)) return next();

                if (!isStaticRoutePrefix(routePrefix)) return next();
                const staticDirectory = STATIC_PAGE_ASSET_DIRECTORIES[routePrefix];

                const filePath = join(staticDirectory, filename);
                try {
                    if (streamAssetFile(res, filePath, ext)) return;
                } catch { }
                next();
            });
        },
    };
}
