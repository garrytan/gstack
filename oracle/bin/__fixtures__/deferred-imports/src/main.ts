import { routes } from "./route-map";

// Top-level dynamic import — eager (NOT deferred)
import("./pages/A");

console.log("Routes:", routes);
