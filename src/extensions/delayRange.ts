import type { ExtensionHandler } from "../types.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const delayRange: ExtensionHandler = async ({ route }) => {
  const range = route.extensions.delayRange;
  if (!range) return "continue" as const;

  const [min, max] = range;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(delay);
  return "continue" as const;
};
