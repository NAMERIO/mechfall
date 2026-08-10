import path from "node:path";
import { fileURLToPath } from "node:url";

export function isMapMakerPublishingRuntime(moduleUrl: string, nodeEnvironment: string | undefined): boolean {
  if (nodeEnvironment === "production") return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const sourceDirectory = path.dirname(filePath);
  return path.basename(filePath).toLowerCase() === "index.ts"
    && path.basename(sourceDirectory).toLowerCase() === "src"
    && path.basename(path.dirname(sourceDirectory)).toLowerCase() === "server";
}

export function isLocalMapMakerRequest(remoteAddress: string | undefined, forwardedFor: string | undefined): boolean {
  if (!isLoopback(remoteAddress)) return false;
  if (!forwardedFor) return true;
  const forwardedAddresses = forwardedFor.split(",").map((value) => value.trim()).filter(Boolean);
  return forwardedAddresses.length > 0 && forwardedAddresses.every(isLoopback);
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}
