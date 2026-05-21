// Slice 0 landing placeholder. Real landing page lands in slice 6
// (wallet adapter, live prices, connect call-to-action).

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-6 px-6 py-16">
      <h1 className="text-5xl font-bold tracking-tight">Meridian</h1>
      <p className="text-xl text-muted">
        Binary stock outcome markets on Solana devnet.
      </p>
      <p className="text-base text-muted">
        Slice 0 scaffold. Real UI lands in slice 6. See{" "}
        <a className="text-accent underline-offset-4 hover:underline" href="https://github.com/scott-lydon/meridian">
          repo
        </a>{" "}
        for status.
      </p>
      <div className="mt-8 rounded-2xl border border-panel bg-panel/50 p-6">
        <h2 className="mb-2 text-lg font-semibold">What is a Meridian contract?</h2>
        <p className="text-sm leading-relaxed text-muted">
          Yes pays <span className="font-mono text-yes">$1.00</span> if the underlying stock closes
          at or above the strike at 16:00 ET. No pays{" "}
          <span className="font-mono text-no">$1.00</span> if it closes below. Yes + No = $1.00,
          always.
        </p>
      </div>
    </main>
  );
}
