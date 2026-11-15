'use client';
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="panel stack">
      <h1>Something broke on this page</h1>
      <p className="muted">Your saved cards and review history are stored on this device and were not touched. {error.name}.</p>
      <button className="btn primary" onClick={reset}>Try again</button>
    </div>
  );
}
