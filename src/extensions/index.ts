import type { ExtensionHandler } from "../types.js";
import { requireAuth } from "./requireAuth.js";
import { rateLimit } from "./rateLimit.js";
import { errorRate } from "./errorRate.js";
import { delayRange } from "./delayRange.js";

export const pipeline: ExtensionHandler[] = [
  requireAuth,
  rateLimit,
  errorRate,
  delayRange,
];

export { clearOnSuccessKeys } from "./rateLimit.js";
