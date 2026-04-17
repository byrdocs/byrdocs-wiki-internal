import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
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

export default function viteExamAssets() {
    let isBuild = false;
    return {
        name: "exam-assets",
        config(_cfg: unknown, env: { command: string }) {
            isBuild = env.command === "build";
        },
        async buildStart(this: { emitFile(file: { type: "asset"; fileName: string; source: Buffer }): string }) {
            if (!isBuild) return;
            for (const { name, path: examDir } of getExamDirectories()) {
                const files = await readdir(examDir);
                for (const file of files) {
                    if (ASSET_EXTENSIONS.has(extname(file).toLowerCase())) {
                        this.emitFile({
                            type: "asset",
                            fileName: `exam/${name}/${file}`,
                            source: await readFile(join(examDir, file)),
                        });
                    }
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
                if (!match) return next();
                const [, examName, filename] = match;
                const ext = extname(filename).toLowerCase();
                if (!ASSET_EXTENSIONS.has(ext)) return next();

                const filePath = join(examsDir, examName, filename);
                try {
                    const stat = statSync(filePath);
                    if (stat.isFile()) {
                        res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                } catch { }
                next();
            });
        },
    };
}
