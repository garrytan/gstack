export const routeTree = {
  routes: [
    { path: "/", component: () => import("./routes/index") },
    { path: "/about", component: () => import("./routes/about") },
  ],
};
