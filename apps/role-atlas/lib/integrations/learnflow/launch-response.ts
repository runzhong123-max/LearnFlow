const launchErrors: Record<string, string> = {
  LEARNFLOW_LOGIN_REQUIRED: "请先登录 LearnFlow，再返回这里重试引用。",
  ROLE_ATLAS_REGISTRY_UNAVAILABLE: "暂时无法读取岗位包目录，请稍后重试；若持续失败，请检查服务端岗位包目录连接。",
  LEARNFLOW_AUTH_UNAVAILABLE: "LearnFlow 登录验证服务暂时不可用，请稍后重试。",
  LEARNFLOW_LAUNCH_NOT_CONFIGURED: "LearnFlow 引用服务尚未配置，请联系维护者。",
  ROLE_PACKAGE_LAUNCH_SECRET_INVALID: "LearnFlow 引用服务配置异常，请联系维护者。",
  RELEASE_NOT_LAUNCHABLE: "这个岗位包版本暂时无法引用，请在岗位包中心检查可用版本。",
  RELEASE_NOT_VISIBLE: "当前岗位包版本不可访问，请检查发布状态。",
};

export async function readLearnFlowLaunchResponse(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (response.ok && typeof data.launchUrl === "string" && data.launchUrl.trim()) return data.launchUrl;
  const code = typeof data.error === "string" ? data.error : "";
  const message = launchErrors[code.split(":")[0]];
  throw new Error(message ? `${message}（${code}）` : `无法进入 LearnFlow，请稍后重试。（HTTP ${response.status}）`);
}
