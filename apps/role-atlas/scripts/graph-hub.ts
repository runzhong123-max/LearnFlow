import { resolve } from "node:path";
import {
  exportGraphHubView,
  initializeGraphHub,
  reviewGraphHubSubmission,
  searchGraphHubFile,
  submitGraphToHub,
} from "../lib/graph-hub/file-graph-hub";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2];
const hubRoot = argument("--hub");
if (!command || !hubRoot) throw new Error("用法：npm run graph-hub -- <init|submit|review|export-view|search> --hub <目录> ...");

let result: unknown;
if (command === "init") {
  result = await initializeGraphHub({
    hubRoot: resolve(hubRoot),
    policy: {
      protocol: "graph-hub-policy.v1",
      officialMaintainerSubjects: (argument("--official") || "").split(",").filter(Boolean),
      reviewerSubjects: (argument("--reviewers") || "").split(",").filter(Boolean),
    },
  });
} else if (command === "submit") {
  const graphFile = argument("--file");
  const owner = argument("--owner");
  if (!graphFile || !owner) throw new Error("submit 需要 --file 与 --owner");
  result = await submitGraphToHub({
    hubRoot: resolve(hubRoot),
    graphFile: resolve(graphFile),
    ownerSubjectId: owner,
    maintainerName: argument("--maintainer") || owner,
    kind: argument("--kind") === "official" ? "official" : "personal",
  });
} else if (command === "review") {
  const submissionId = argument("--submission");
  const reviewer = argument("--reviewer");
  if (!submissionId || !reviewer) throw new Error("review 需要 --submission 与 --reviewer");
  result = await reviewGraphHubSubmission({
    hubRoot: resolve(hubRoot),
    submissionId,
    reviewerSubjectId: reviewer,
    decision: argument("--decision") === "reject" ? "reject" : "approve",
    notes: argument("--notes"),
  });
} else if (command === "export-view") {
  const outputFile = argument("--out");
  if (!outputFile) throw new Error("export-view 需要 --out");
  result = await exportGraphHubView({
    hubRoot: resolve(hubRoot),
    outputFile: resolve(outputFile),
    actorSubjectId: argument("--actor"),
  });
} else if (command === "search") {
  const query = argument("--query");
  const catalogFile = argument("--catalog") || resolve(hubRoot, "catalog.json");
  const category = argument("--category");
  if (!query && !category) throw new Error("search 需要 --query 或 --category");
  result = await searchGraphHubFile({
    catalogFile: resolve(catalogFile),
    query: query || "",
    category,
    actorSubjectId: argument("--actor"),
    limit: Number(argument("--limit") || 8),
  });
} else {
  throw new Error(`未知命令：${command}`);
}

console.log(JSON.stringify(result, null, 2));
