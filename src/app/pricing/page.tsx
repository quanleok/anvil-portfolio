import Link from "next/link";

export const metadata = {
  title: "Anvil Pricing",
  description:
    "Anvil pricing: the local desktop app plus protected Anvil methods through a $100 one-year license.",
};

export default function PricingPage() {
  return (
    <main className="relative flex min-h-screen flex-col bg-background text-foreground">
      <header className="px-8 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anvil-logo.png" alt="" width={20} height={20} />
            <span>Anvil</span>
          </Link>
          <Link
            href="/app"
            className="rounded-md border border-[#a78bfa]/40 bg-[#a78bfa]/15 px-3 py-2 text-[13px] font-semibold text-[#ede9fe] transition hover:border-[#c4b5fd]/60 hover:bg-[#a78bfa]/22"
          >
            Open in browser
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center px-8 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#c4b5fd]/70">
            Annual license
          </p>
          <h1 className="mt-4 text-balance text-4xl font-semibold leading-tight text-white sm:text-5xl">
            Anvil License is $100 for one year.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-zinc-400">
            The local desktop app stays built around your own Codex, Claude Code,
            OpenClaw, Hermes, or other local CLI. The paid license is the server
            side Anvil layer: protected workflow methods, hosted Anvil agent
            access, and future premium skill packs.
          </p>
          <div className="mx-auto mt-10 max-w-md rounded-lg border border-white/10 bg-zinc-950/70 p-6 text-left">
            <div className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#c4b5fd]/75">
              Anvil License
            </div>
            <div className="mt-3 text-5xl font-semibold tracking-tight text-white">$100</div>
            <div className="mt-2 text-sm text-zinc-400">1-year license</div>
            <ul className="mt-6 space-y-3 text-sm leading-6 text-zinc-300">
              <li>Local project workspace</li>
              <li>Bring your own local agent and provider keys</li>
              <li>Protected Anvil workflow methods when enabled</li>
              <li>Hosted Anvil agent access when enabled</li>
            </ul>
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/app"
              className="rounded-md bg-[#a78bfa] px-5 py-3 text-sm font-semibold text-[#080c11] transition hover:bg-[#c4b5fd]"
            >
              Open in browser
            </Link>
            <Link
              href="/"
              className="rounded-md border border-white/10 px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:text-white"
            >
              Back home
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
