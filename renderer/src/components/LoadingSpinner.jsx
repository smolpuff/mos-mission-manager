export default function LoadingSpinner({ className = "" }) {
  return (
    <span
      className={`loading loading-spinner loading-sm text-white shrink-0 ${className}`}
      aria-hidden="true"
    />
  );
}
