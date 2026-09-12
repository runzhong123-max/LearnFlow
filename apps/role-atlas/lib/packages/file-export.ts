import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleToJson } from "./archive";
import type { StaticRolePackageBundle, StaticRolePackageManifest } from "./types";
import { validatePackageBundle } from "./validator";

const REQUIRED_ENTRYPOINTS = [
  "snapshot",
  "sources",
  "semanticGraph",
  "workProcessForest",
  "views",
  "objectIndex",
  "retrieval",
  "validation",
  "referenceMigrations",
] as const;

function assertSafeComponentPath(path: string) {
  if (!path || isAbsolute(path) || path.includes("..") || path.includes("\\")) {
    throw new Error(`UNSAFE_COMPONENT_PATH:${path}`);
  }
}

function parseManifest(raw: string, sourceDirectory: string) {
  const manifest = JSON.parse(raw) as StaticRolePackageManifest;
  if (manifest.packageProtocol !== "static-role-package" || !["2.0.0", "3.0.0", "3.1.0"].includes(manifest.protocolVersion)) {
    throw new Error(`UNSUPPORTED_ROLE_PACKAGE:${sourceDirectory}`);
  }
  for (const key of REQUIRED_ENTRYPOINTS) {
    const path = manifest.entrypoints[key];
    assertSafeComponentPath(path);
    if (!manifest.hashes[path]) throw new Error(`ENTRYPOINT_HASH_MISSING:${key}`);
  }
  for (const path of Object.keys(manifest.hashes)) assertSafeComponentPath(path);
  return manifest;
}

export async function readStaticRolePackageDirectory(sourceDirectory: string): Promise<StaticRolePackageBundle> {
  const directory = resolve(sourceDirectory);
  const manifest = parseManifest(await readFile(resolve(directory, "manifest.json"), "utf8"), directory);
  const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes)
    .sort()
    .map(async (path) => [path, await readFile(resolve(directory, path), "utf8")] as const)));
  const bundle = { manifest, components };
  const validation = await validatePackageBundle(bundle);
  if (!validation.valid) throw new Error(`PACKAGE_INVALID:${validation.hardErrors.join("|")}`);
  return bundle;
}

export async function exportStaticRolePackageFile(input: { sourceDirectory: string; outputFile: string }) {
  const bundle = await readStaticRolePackageDirectory(input.sourceDirectory);
  const outputFile = resolve(input.outputFile);
  await mkdir(dirname(outputFile), { recursive: true });
  try {
    await access(outputFile, constants.F_OK);
    throw new Error(`OUTPUT_EXISTS:${outputFile}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temporaryFile = resolve(dirname(outputFile), `.${basename(outputFile)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, bundleToJson(bundle), { encoding: "utf8", flag: "wx" });
    await copyFile(temporaryFile, outputFile, constants.COPYFILE_EXCL);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return {
    protocol: "role-package-file-export.v1",
    outputFile,
    packageId: bundle.manifest.packageId,
    packageVersion: bundle.manifest.packageVersion,
    snapshotId: bundle.manifest.snapshotId,
    rootHash: bundle.manifest.rootHash,
    components: Object.keys(bundle.components).length,
  };
}
