export default function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      className={`inline-block w-5 h-5 border-2 border-gstack-border border-t-gstack-accent rounded-full animate-spin ${className}`}
    />
  );
}
