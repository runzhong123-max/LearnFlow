import { serverActor } from "@/lib/access-server";
import type { Metadata } from "next";
import { listRegistryPackages } from "@/lib/registry/repository";
import RegistryCatalog from "./RegistryCatalog";

export const metadata: Metadata = { title: "岗位包中心 · Role Atlas" };

export default async function RegistryPage() {
  const actor = await serverActor();
  return <RegistryCatalog
    initialPackages={actor ? await listRegistryPackages({ ownerSubjectId: actor.subjectId }) : []}
    roleAtlasBaseUrl={process.env.ROLE_ATLAS_PUBLIC_URL || ""}
    graphHubBaseUrl={process.env.GRAPH_HUB_PUBLIC_URL || ""}
  />;
}
