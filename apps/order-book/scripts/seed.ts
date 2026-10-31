import { seed } from "../src/seed";
import { manifest, post } from "./src/client";

await seed(manifest, (mutation) => post("/api", mutation));
console.log("seeded the order book");
