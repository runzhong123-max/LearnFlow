import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import InlineRegistryCenter from "@/app/components/InlineRegistryCenter";
import "@/app/components/project-workspace.css";

export const metadata: Metadata = { title: "我的岗位包 · Role Atlas" };

export default function RegistryPage() {
  return <main className="personal-registry-page">
    <Link className="personal-registry-return" href="/"><ArrowLeft size={14} /> 返回工作台</Link>
    <InlineRegistryCenter standalone />
  </main>;
}
