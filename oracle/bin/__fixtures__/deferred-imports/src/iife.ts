// IIFE with dynamic import — eager (NOT deferred)
(async () => {
  await import("./pages/B");
})();
