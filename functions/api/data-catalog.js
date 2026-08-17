import { proxyRaw } from "./_util.js";

export function onRequestGet() {
  return proxyRaw("data/data-catalog.json", { cacheSeconds: 300 });
}
