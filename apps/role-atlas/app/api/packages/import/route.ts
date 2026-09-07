import { authorizeApiRequest } from "@/lib/access";
import { importStaticRolePackage } from "@/lib/packages/importer";

export const runtime = "edge";

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const contentType = request.headers.get("content-type") || "";
    let bytes: Uint8Array;
    let format: "json" | "zip";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "缺少岗位包文件。" }, { status: 400 });
      bytes = new Uint8Array(await file.arrayBuffer());
      format = file.name.toLowerCase().endsWith(".zip") ? "zip" : "json";
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
      format = contentType.includes("zip") ? "zip" : "json";
    }
    const imported = await importStaticRolePackage({ bytes, format });
    return Response.json(imported, { status: imported.imported ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "岗位包导入失败。";
    return Response.json({ error: message }, { status: /CONFLICT/u.test(message) ? 409 : 400 });
  }
}
