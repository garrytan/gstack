// Class method with dynamic import — deferred (NOT eager)
class Loader {
  load() {
    return import("./pages/C");
  }
}

export { Loader };
