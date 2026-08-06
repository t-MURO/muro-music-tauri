"use strict";

// Build-time only. The staged executables are launched directly by Rust; Node
// is not bundled with, or required by, the installed application.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const KEYFINDER_VERSION = "v0.1.2";
const FPCALC_VERSION = "1.6.0";
const KEYFINDER_RELEASE_ROOT =
  `https://github.com/t-MURO/neo-keyfinder/releases/download/${KEYFINDER_VERSION}`;
const FPCALC_RELEASE_ROOT =
  `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}`;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const projectRoot = path.resolve(__dirname, "..");
const binariesRoot = path.join(projectRoot, "src-tauri", "binaries");
const keyfinderManifestPath = path.join(
  __dirname,
  "keyfinder-checksums",
  `${KEYFINDER_VERSION}.sha256`,
);

const FPCALC_ASSETS = {
  "win32-x64": {
    name: `chromaprint-fpcalc-${FPCALC_VERSION}-windows-x86_64.zip`,
    sha256: "30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a",
  },
  "darwin-x64": {
    name: `chromaprint-fpcalc-${FPCALC_VERSION}-macos-x86_64.tar.gz`,
    sha256: "5898f2442220f4d82920b9eb11c35fc30d379b1ce9cb8b9f869f3365d2236e99",
  },
  "darwin-arm64": {
    name: `chromaprint-fpcalc-${FPCALC_VERSION}-macos-arm64.tar.gz`,
    sha256: "2c6c837f57ab5ad330710dc296af4de62a51d3c14aa2309fe1afce2ab699bd35",
  },
  "linux-x64": {
    name: `chromaprint-fpcalc-${FPCALC_VERSION}-linux-x86_64.tar.gz`,
    sha256: "946dc3eade645eb835c8d163c6bb354e092239988bff190b9c42589e8d5cf00a",
  },
  "linux-arm64": {
    name: `chromaprint-fpcalc-${FPCALC_VERSION}-linux-arm64.tar.gz`,
    sha256: "c8667f556f77d8ebbe08b75a968c0592bd2a67aaa696eff91715feb5083b1cd4",
  },
};

// Tauri externalBin requires the destination suffix to match the Rust build
// target. A Windows MSVC sidecar is a normal PE executable and can also be
// staged under a GNU Rust target suffix when Cargo itself is using GNU.
const TARGETS = {
  "x86_64-pc-windows-msvc": {
    platform: "win32",
    arch: "x64",
    keyfinderTriple: "x86_64-pc-windows-msvc",
  },
  "x86_64-pc-windows-gnu": {
    platform: "win32",
    arch: "x64",
    keyfinderTriple: "x86_64-pc-windows-msvc",
  },
  "aarch64-pc-windows-msvc": {
    platform: "win32",
    arch: "arm64",
    keyfinderTriple: "aarch64-pc-windows-msvc",
  },
  "aarch64-pc-windows-gnu": {
    platform: "win32",
    arch: "arm64",
    keyfinderTriple: "aarch64-pc-windows-msvc",
  },
  "x86_64-apple-darwin": {
    platform: "darwin",
    arch: "x64",
    keyfinderTriple: "x86_64-apple-darwin",
  },
  "aarch64-apple-darwin": {
    platform: "darwin",
    arch: "arm64",
    keyfinderTriple: "aarch64-apple-darwin",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux",
    arch: "x64",
    keyfinderTriple: "x86_64-unknown-linux-gnu",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux",
    arch: "arm64",
    keyfinderTriple: "aarch64-unknown-linux-gnu",
  },
};

const inferredTarget = () => {
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  throw new Error(`Native analysis sidecars are not supported on ${process.platform}`);
};

const requestedTarget = () => {
  const target = String(
    process.env.TAURI_ENV_TARGET_TRIPLE
      || process.env.CARGO_BUILD_TARGET
      || inferredTarget(),
  ).trim();
  if (!Object.hasOwn(TARGETS, target)) {
    throw new Error(
      `Unsupported native sidecar target "${target}". Supported targets: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return target;
};

const defaultCacheRoot = () => {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "MuroMusic", "native-sidecars");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "MuroMusic", "native-sidecars");
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "muro-music",
    "native-sidecars",
  );
};

const cacheRoot = path.resolve(
  process.env.MURO_SIDECAR_CACHE_DIR || defaultCacheRoot(),
);

const sha256 = (contents) =>
  crypto.createHash("sha256").update(contents).digest("hex");

const fileSha256 = (filePath) => sha256(fs.readFileSync(filePath));

const isVerifiedFile = (filePath, expectedChecksum) => {
  try {
    return fs.statSync(filePath).isFile()
      && fs.statSync(filePath).size >= 1_024
      && fileSha256(filePath) === expectedChecksum;
  } catch {
    return false;
  }
};

const readKeyfinderChecksums = () => {
  if (!fs.existsSync(keyfinderManifestPath)) {
    throw new Error(
      `The trusted Neo KeyFinder checksum manifest is missing: ${keyfinderManifestPath}`,
    );
  }
  const checksums = new Map();
  for (const rawLine of fs.readFileSync(keyfinderManifestPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-f0-9]{64})\s+[ *](\S+)$/i);
    if (!match) {
      throw new Error(`Invalid line in ${keyfinderManifestPath}: ${rawLine}`);
    }
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
};

const downloadHeaders = {
  "User-Agent": "Muro-Music-native-sidecar-builder",
  Accept: "application/octet-stream",
};
if (process.env.GH_TOKEN) {
  downloadHeaders.Authorization = `Bearer ${process.env.GH_TOKEN}`;
}

const download = async (url, label) => {
  const response = await fetch(url, {
    headers: downloadHeaders,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Could not download ${label}: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${label} is unexpectedly large (${declaredLength} bytes)`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.length < 1_024 || contents.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${label} has an unexpected size (${contents.length} bytes)`);
  }
  return contents;
};

const atomicWrite = (destination, contents, executable) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, contents, { mode: executable ? 0o755 : 0o644 });
    if (executable && process.platform !== "win32") fs.chmodSync(temporary, 0o755);
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

const verifiedCachedDownload = async ({ url, name, expectedChecksum, cacheDirectory }) => {
  const destination = path.join(cacheRoot, cacheDirectory, name);
  if (isVerifiedFile(destination, expectedChecksum)) {
    console.log(`Using verified cached download: ${destination}`);
    return destination;
  }

  console.log(`Downloading and verifying ${name}...`);
  const contents = await download(url, name);
  const actualChecksum = sha256(contents);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum mismatch for ${name}: expected ${expectedChecksum}, received ${actualChecksum}`,
    );
  }
  atomicWrite(destination, contents, false);
  return destination;
};

const atomicCopyExecutable = (source, destination) => {
  const contents = fs.readFileSync(source);
  if (contents.length < 1_024) {
    throw new Error(`Native executable is unexpectedly small: ${source}`);
  }
  atomicWrite(destination, contents, true);
};

const safeRemoveTemporaryRoot = (temporaryRoot) => {
  const relative = path.relative(cacheRoot, temporaryRoot);
  const valid = relative
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && path.basename(temporaryRoot).startsWith(".extract-");
  if (!valid) {
    throw new Error(`Refusing to remove unexpected temporary path: ${temporaryRoot}`);
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
};

const findFile = (root, expectedName) => {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(candidate, expectedName);
      if (nested) return nested;
    } else if (
      entry.isFile()
      && entry.name.toLocaleLowerCase() === expectedName.toLocaleLowerCase()
    ) {
      return candidate;
    }
  }
  return null;
};

const extractFpcalc = (archivePath, executableName) => {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(cacheRoot, ".extract-"));
  try {
    const extractedRoot = path.join(temporaryRoot, "contents");
    fs.mkdirSync(extractedRoot, { recursive: true });
    const result = spawnSync("tar", ["-xf", archivePath, "-C", extractedRoot], {
      stdio: "pipe",
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || "").trim();
      throw result.error || new Error(
        `Could not extract ${path.basename(archivePath)}${detail ? `: ${detail}` : ""}`,
      );
    }
    const executable = findFile(extractedRoot, executableName);
    if (!executable) {
      throw new Error(`${executableName} was not found in ${path.basename(archivePath)}`);
    }
    const contents = fs.readFileSync(executable);
    if (contents.length < 1_024) {
      throw new Error(`Extracted ${executableName} is unexpectedly small`);
    }
    return contents;
  } finally {
    safeRemoveTemporaryRoot(temporaryRoot);
  }
};

const assertTargetArtifacts = (target, configuration, checksums) => {
  const targetKey = `${configuration.platform}-${configuration.arch}`;
  const extension = configuration.platform === "win32" ? ".exe" : "";
  const keyfinderName = `keyfinder-native-${configuration.keyfinderTriple}${extension}`;
  const keyfinderChecksum = checksums.get(keyfinderName);
  const fpcalcAsset = FPCALC_ASSETS[targetKey];
  const missing = [];
  if (!keyfinderChecksum) {
    missing.push(`Neo KeyFinder ${KEYFINDER_VERSION}`);
  }
  if (!fpcalcAsset) {
    missing.push(`Chromaprint fpcalc ${FPCALC_VERSION}`);
  }
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} do not have trusted published artifacts for ${target}. `
      + "Build and checksum the missing native runtime before packaging this target.",
    );
  }
  return { extension, keyfinderName, keyfinderChecksum, fpcalcAsset };
};

const main = async () => {
  const target = requestedTarget();
  const configuration = TARGETS[target];
  const checksums = readKeyfinderChecksums();
  const {
    extension,
    keyfinderName,
    keyfinderChecksum,
    fpcalcAsset,
  } = assertTargetArtifacts(target, configuration, checksums);

  const keyfinderCached = await verifiedCachedDownload({
    url: `${KEYFINDER_RELEASE_ROOT}/${encodeURIComponent(keyfinderName)}`,
    name: keyfinderName,
    expectedChecksum: keyfinderChecksum,
    cacheDirectory: `neo-keyfinder-${KEYFINDER_VERSION}`,
  });
  const keyfinderDestination = path.join(
    binariesRoot,
    `keyfinder-native-${target}${extension}`,
  );
  if (!isVerifiedFile(keyfinderDestination, keyfinderChecksum)) {
    atomicCopyExecutable(keyfinderCached, keyfinderDestination);
  } else if (configuration.platform !== "win32") {
    fs.chmodSync(keyfinderDestination, 0o755);
  }

  const fpcalcArchive = await verifiedCachedDownload({
    url: `${FPCALC_RELEASE_ROOT}/${encodeURIComponent(fpcalcAsset.name)}`,
    name: fpcalcAsset.name,
    expectedChecksum: fpcalcAsset.sha256,
    cacheDirectory: `chromaprint-${FPCALC_VERSION}`,
  });
  const executableName = configuration.platform === "win32" ? "fpcalc.exe" : "fpcalc";
  const fpcalcContents = extractFpcalc(fpcalcArchive, executableName);
  const fpcalcDestination = path.join(
    binariesRoot,
    `fpcalc-${target}${extension}`,
  );
  atomicWrite(fpcalcDestination, fpcalcContents, true);

  console.log(`Prepared Tauri native sidecars for ${target}:`);
  console.log(`  ${keyfinderDestination}`);
  console.log(`  ${fpcalcDestination}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
