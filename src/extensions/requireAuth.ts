import type { ExtensionHandler } from "../types.js";

export const requireAuth: ExtensionHandler = ({ req, res, route, ctx }) => {
  if (!route.extensions.requireAuth) return "continue";

  const headerValue = req.header(ctx.auth.headerName) ?? "";
  const pattern = new RegExp(ctx.auth.pattern);

  if (!pattern.test(headerValue)) {
    res.status(401).json({
      error: "Unauthorized",
      message: `Missing or invalid '${ctx.auth.headerName}' header`,
    });
    return "halt";
  }

  return "continue";
};
