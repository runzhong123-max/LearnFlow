/** User-visible AI/network budgets. Resource-protection timeouts live elsewhere. */
export const AI_LATENCY_BUDGETS = Object.freeze({
  tutorClient: Object.freeze({ standard: 420_000, planning: 540_000, guided: 600_000, diagram: 660_000, animation: 780_000 }),
  agentTurn: Object.freeze({ standard: 360_000, planning: 480_000, guided: 540_000, diagram: 600_000, animation: 720_000 }),
  providerRequest: 180_000,
  providerProxyDefault: 210_000,
  formalApi: 120_000,
  backendProxy: 180_000,
  visualPlanner: Object.freeze({ diagram: 150_000, animation: 210_000, diagramRepair: 120_000, animationRepair: 150_000 }),
  searchProvider: 20_000,
  videoProvider: 30_000,
  desktopStartup: 180_000,
})
