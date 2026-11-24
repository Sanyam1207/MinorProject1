// Downloads a static Tectonic build into backend/bin/ so Linux hosts (such as
// Render) can compile resume PDFs locally (docs/contracts/RESUME-BYOK.md §6.1).
// Port of Matchy scripts/install-tectonic.js; runs as `postinstall`.
//
// Does nothing on non-Linux platforms (use Homebrew + TECTONIC_BIN on a Mac),
// when bin/tectonic already exists, or when TECTONIC_SKIP_DOWNLOAD=true.
// A failed download only WARNS (exit code 0) so `npm install` never breaks
// offline; compiles then answer 503 COMPILER_UNAVAILABLE until it is installed.
import { execFile } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION = "0.17.0";
const TARGETS = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" };

const binDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const binaryPath = join(binDirectory, "tectonic");

const exists = async (path) => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const install = async () => {
    if (process.platform !== "linux" || String(process.env.TECTONIC_SKIP_DOWNLOAD).toLowerCase() === "true") return;
    if (await exists(binaryPath)) return;

    const target = TARGETS[process.arch];
    if (!target) {
        console.warn(`Tectonic: no prebuilt binary for linux/${process.arch}. Install it yourself and set TECTONIC_BIN.`);
        return;
    }

    const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/tectonic-${VERSION}-${target}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);

    await mkdir(binDirectory, { recursive: true });
    const archivePath = join(binDirectory, "tectonic.tar.gz");
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    try {
        await execFileAsync("tar", ["-xzf", archivePath, "-C", binDirectory]);
    } finally {
        await rm(archivePath, { force: true });
    }
    await chmod(binaryPath, 0o755);
    const { stdout } = await execFileAsync(binaryPath, ["--version"]);
    console.log(`Tectonic: installed ${stdout.trim()} at ${binaryPath}`);
};

install().catch((error) => {
    console.warn(`Tectonic: not installed (${error.message}). Resume PDF compiles will be unavailable until it is (set TECTONIC_BIN or rerun npm install).`);
});
