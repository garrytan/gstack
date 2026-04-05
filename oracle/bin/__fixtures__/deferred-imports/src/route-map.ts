// All imports here are in arrow functions — deferred (NOT eager)
export const routes = {
  a: () => import("./pages/A"),
  b: () => import("./pages/B"),
  c: () => import("./pages/C"),
};
