import type { ExtensionHandler } from "../types.js";

export const errorRate: ExtensionHandler = ({ req, res, route }) => {
  const rate = route.extensions.errorRate;
  if (typeof rate !== "number" || rate <= 0) return "continue";

  if (Math.random() < rate) {
    res.status(500).json({
      error: "Injected error",
      message: `errorRate=${rate} triggered`,
      route: route.id,
      requestId: req.header("x-request-id") ?? undefined,
    });
    return "halt";
  }

  return "continue";
};
