import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const learnFlowRoot = process.env.LEARNFLOW_ROOT
  ? resolve(process.env.LEARNFLOW_ROOT)
  : resolve(projectRoot, "../..");
const source = resolve(learnFlowRoot, "frontend/src/learning-path-graph.ts");
const module = await import(pathToFileURL(source).href) as {
  exportOfficialLearningPathContract: () => unknown;
  exportOfficialLearningPathContractV2: () => unknown;
};
const validator = await import(pathToFileURL(resolve(learnFlowRoot, "frontend/src/learning-path-contract-v2.ts")).href) as {
  validateLearningPathGraphV2: (input: unknown) => { valid: boolean; issues: unknown[] };
};
// Validate before touching either checked-in consumer artifact. v1 remains the live reader.
const v1 = module.exportOfficialLearningPathContract();
const v2 = module.exportOfficialLearningPathContractV2();
const checked = validator.validateLearningPathGraphV2(v2);
if (!checked.valid) throw new Error(JSON.stringify(checked.issues));
await mkdir(resolve(projectRoot, "public/data"), { recursive: true });
for (const [filename, contract] of [
  ["learnflow-learning-path.json", v1],
  ["learnflow-learning-path.v2.json", v2],
] as const) {
  const output = resolve(projectRoot, "public/data", filename);
  await writeFile(output, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}
