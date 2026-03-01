/// <reference path="./node.d.ts" />
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";

let client: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
  if (!client) {
    const url = process.env.CONVEX_URL;
    if (!url) {
      throw new Error("CONVEX_URL environment variable is required");
    }
    client = new ConvexHttpClient(url);
    console.log("Convex client initialized");
  }
  return client;
}

export { api };
