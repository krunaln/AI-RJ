import { rm } from "node:fs/promises";

await rm(new URL("./.next", import.meta.url), { recursive: true, force: true });
console.log("cleaned dashboard/.next");
