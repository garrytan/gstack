import { Route } from "wouter";
export default function App() {
  return (
    <>
      <Route path="/" component={Home} />
      <Route path="/about" component={About} />
    </>
  );
}
