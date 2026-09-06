export type GraphHubKind = "official" | "personal";
export type GraphHubReviewStatus = "pending" | "approved" | "rejected";
export type GraphHubGraphType = "learning_path" | "role_semantic" | "role_process" | "knowledge" | "custom";

export type GraphHubPolicy = {
  protocol: "graph-hub-policy.v1";
  officialMaintainerSubjects: string[];
  reviewerSubjects: string[];
};

export type GraphHubNode = {
  id: string;
  label: string;
  type: string;
  summary?: string;
  aliases?: string[];
  tags?: string[];
};

export type GraphHubEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  summary?: string;
};

export type GraphHubDocument = {
  protocol: "graph-hub-document.v1";
  graphId: string;
  version: string;
  graphType: GraphHubGraphType;
  title: string;
  summary: string;
  keywords: string[];
  nodes: GraphHubNode[];
  edges: GraphHubEdge[];
  source?: {
    packageId?: string;
    packageVersion?: string;
    snapshotId?: string;
  };
};

export type GraphHubSubmission = {
  protocol: "graph-hub-submission.v1";
  submissionId: string;
  graphId: string;
  graphVersion: string;
  graphType: GraphHubGraphType;
  title: string;
  summary: string;
  keywords: string[];
  ownerSubjectId: string;
  maintainerName: string;
  kind: GraphHubKind;
  reviewStatus: GraphHubReviewStatus;
  objectHash: string;
  objectPath: string;
  submittedAt: string;
  reviewedAt?: string;
  reviewerSubjectId?: string;
  reviewNotes?: string;
};

export type GraphHubCatalogEntry = {
  categories?: string[];
  graphId: string;
  graphVersion: string;
  graphType: GraphHubGraphType;
  title: string;
  summary: string;
  keywords: string[];
  ownerSubjectId: string;
  maintainerName: string;
  kind: GraphHubKind;
  review: "official" | "approved" | "pending_owner" | "rejected_owner";
  access: "public" | "owner";
  objectHash: string;
  objectPath: string;
  submittedAt: string;
  reviewedAt?: string;
  nodeIndex: GraphHubNode[];
};

export type GraphHubCatalog = {
  protocol: "graph-hub-catalog.v1";
  generatedAt: string;
  audienceSubjectId?: string;
  entries: GraphHubCatalogEntry[];
  rootHash: string;
};

export type GraphHubSearchResult = {
  entry: GraphHubCatalogEntry;
  score: number;
  matchedTerms: string[];
  matchedNodes: Array<GraphHubNode & { score: number }>;
};
