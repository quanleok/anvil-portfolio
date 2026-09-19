import Hero3DMount from "./Hero3DMount";

const steps = [
  {
    n: "01",
    text: "Download Anvil and open a local project folder.",
  },
  {
    n: "02",
    text: "Run Codex, Claude Code, or your own agent in the terminal pane.",
  },
  {
    n: "03",
    text: "Use your own API keys locally for image, video, audio, and agent work.",
  },
  {
    n: "04",
    text: "Keep scripts, prompts, references, and generated takes in one folder.",
  },
];

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col bg-background text-foreground">
      {/* ============================================================
          HERO — full viewport, floating 3D anvil + wordmark + tagline
          ============================================================ */}
      <section className="relative flex min-h-screen flex-col overflow-hidden">
        {/* Atmospheric glow — behind everything. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_620px_at_50%_38%,rgba(167,139,250,0.24),transparent_70%)]"
        />

        {/* Top bar — tiny wordmark left, compact CTA right. */}
        <header className="relative z-20 flex items-center justify-between px-8 py-6">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-white/90">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anvil-logo.png" alt="" width={22} height={22} className="opacity-90" />
            <span>Anvil</span>
          </div>
          <nav className="flex items-center gap-1 text-[13px] font-semibold sm:gap-2">
            <a
              href="/pricing"
              className="px-3 py-2 text-zinc-400 transition hover:text-white"
            >
              Pricing
            </a>
            <a
              href="/app"
              className="px-3 py-2 text-zinc-400 transition hover:text-white"
            >
              Open in browser
            </a>
            <a
              href="/app/login"
              className="px-3 py-2 text-zinc-300 transition hover:text-white"
            >
              Login
            </a>
          </nav>
        </header>

        {/* Centre stack — tool anvil mark, 3D wordmark, tagline, CTA. */}
        {/* Interactive hero canvas — full-width within the hero section.
            Hammer follows the cursor anywhere inside this section; cross
            the anvil to swing + clang. The Canvas extends full width and
            full hero height (above the next section), so the entire hero
            area is the playground. The wordmark + tagline render as a
            pointer-events-none overlay so the cursor still drives the
            hammer when crossing them. */}
        <div className="absolute inset-0 z-0">
          <Hero3DMount />
        </div>

        <div className="pointer-events-none relative z-10 flex flex-1 flex-col items-center justify-end px-6 pb-16">
          {/* Spacer keeps the wordmark down where the old anvil container
              ended, so the visual rhythm matches the original design. */}
          <div className="h-[52vh] max-h-[580px] min-h-[360px] w-full" aria-hidden="true" />

          {/* Name + tagline, centred beneath the mark. pointer-events-none
              on the wrapper so the cursor passes through to the canvas
              underneath even when hovering the text. The CTA group below
              the tagline opts back into pointer events so the buttons stay
              clickable. */}
          <div className="mt-6 flex flex-col items-center gap-3 text-center">
            <div className="text-[40px] font-semibold leading-none tracking-tight text-white sm:text-[52px]">
              Anvil
            </div>
            <div className="max-w-xl text-[15px] leading-7 text-zinc-400 sm:text-base">
              The workshop for AI-generated film.
            </div>
            <div className="pointer-events-auto mt-5 flex flex-wrap items-center justify-center gap-3">
              <a
                href="/app"
                className="rounded-md bg-[#a78bfa] px-5 py-2.5 text-sm font-semibold text-[#080c11] shadow-[0_8px_30px_-12px_rgba(167,139,250,0.6)] transition hover:bg-[#c4b5fd]"
              >
                Open in browser
              </a>
            </div>
          </div>

        </div>
      </section>

      {/* ============================================================
          PITCH — one big statement, wall of whitespace, no tiles
          ============================================================ */}
      <section className="relative border-t border-white/5 py-40">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[rgba(167,139,250,0.4)] to-transparent"
        />
        <div className="mx-auto max-w-3xl px-8 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#c4b5fd]">
            What it is
          </div>
          <h2 className="mt-6 text-4xl font-semibold leading-[1.15] tracking-tight text-white sm:text-5xl">
            Not a chatbot.
            <br />
            <span className="text-[#c4b5fd]">A workspace your whole film lives in.</span>
          </h2>
          <p className="mx-auto mt-8 max-w-xl text-base leading-8 text-zinc-400">
            Script, scenes, shots, prompts, and references in one project folder on your machine — with your own local agent working from the same folder.
          </p>
        </div>
      </section>

      {/* ============================================================
          THE LOOP — big numbered steps, single column, spaced
          ============================================================ */}
      <section className="relative border-t border-white/5 py-32">
        <div className="mx-auto max-w-3xl px-8">
          <div className="text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#c4b5fd]">
              The loop
            </div>
            <h2 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
              One folder. One agent. One loop.
            </h2>
          </div>
          <ol className="relative mt-20 space-y-14">
            {/* Vertical trail connecting the step numbers — sits behind the
                numeric markers, gives the four steps a visible "loop". */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-[1.55rem] top-3 bottom-3 w-px bg-gradient-to-b from-transparent via-[rgba(196,181,253,0.18)] to-transparent sm:left-[1.75rem]"
            />
            {steps.map((step) => (
              <li key={step.n} className="relative grid grid-cols-[auto_1fr] items-baseline gap-10">
                <span className="relative font-mono text-[56px] font-light leading-none text-[#c4b5fd]/45">
                  {step.n}
                  {/* Dot on the trail line so each step reads as a beat. */}
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[#c4b5fd]/60"
                  />
                </span>
                <p className="text-xl leading-9 text-zinc-300 sm:text-2xl sm:leading-10">
                  {step.text}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ============================================================
          THE RULE — one-liner manifesto fragments
          ============================================================ */}
      <section className="relative border-t border-white/5 py-32">
        <div className="mx-auto max-w-3xl px-8 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#c4b5fd]">
            Promises
          </div>
          <div className="mt-16 space-y-12">
            <p className="text-2xl leading-10 text-white sm:text-3xl sm:leading-[1.4]">
              Your files are yours.
              <span className="block text-zinc-400">
                Plain markdown, plain images, on your disk. Git it if you want.
              </span>
            </p>
            <p className="text-2xl leading-10 text-white sm:text-3xl sm:leading-[1.4]">
              Built for Seedance 2.0.
              <span className="block text-zinc-400">
                Prompt planning, continuity handoff, and a local media library for short-form video.
              </span>
            </p>
            <p className="text-2xl leading-10 text-white sm:text-3xl sm:leading-[1.4]">
              Built for the workflow.
              <span className="block text-zinc-400">
                Write the script, shape the prompts, track the generated outputs.
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* ============================================================
          DOWNLOAD — desktop-first release
          ============================================================ */}
      <section id="download" className="relative border-t border-white/5 py-36 scroll-mt-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[rgba(167,139,250,0.4)] to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(640px_400px_at_50%_50%,rgba(167,139,250,0.14),transparent_70%)]"
        />
        <div className="relative mx-auto max-w-3xl px-8 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#c4b5fd]">
            Desktop-first release
          </div>
          <h2 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
            Bring your own agent.
          </h2>
          <p className="mx-auto mt-8 max-w-xl text-base leading-8 text-zinc-400">
            Open the project terminal and run the CLI you already use — Codex, Claude Code, OpenClaw, Hermes, or your own local agent.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/app"
              className="rounded-md bg-[#a78bfa] px-5 py-3 text-sm font-semibold text-[#080c11] transition hover:bg-[#c4b5fd]"
            >
              Open in browser
            </a>
            <span
              className="rounded-md border border-white/10 px-5 py-3 text-sm font-semibold text-zinc-500"
              aria-disabled="true"
            >
              Desktop build coming soon
            </span>
          </div>

          <ul className="mx-auto mt-14 max-w-xl space-y-7 text-left">
            <li className="grid grid-cols-[auto_1fr] items-start gap-5">
              <span
                aria-hidden="true"
                className="mt-2.5 inline-block h-1.5 w-1.5 rounded-full bg-[#c4b5fd]"
              />
              <div>
                <div className="text-[15px] font-semibold text-white">$100 annual license</div>
                <p className="mt-1 text-sm leading-6 text-zinc-400">
                  One year of Anvil access for protected workflow methods, hosted agent features, and future premium skill packs.
                </p>
              </div>
            </li>
            <li className="grid grid-cols-[auto_1fr] items-start gap-5">
              <span
                aria-hidden="true"
                className="mt-2.5 inline-block h-1.5 w-1.5 rounded-full bg-[#c4b5fd]"
              />
              <div>
                <div className="text-[15px] font-semibold text-white">Terminal first</div>
                <p className="mt-1 text-sm leading-6 text-zinc-400">
                  The right panel is a normal project terminal. Run the agent you trust, using your own plan and local permissions.
                </p>
              </div>
            </li>
            <li className="grid grid-cols-[auto_1fr] items-start gap-5">
              <span
                aria-hidden="true"
                className="mt-2.5 inline-block h-1.5 w-1.5 rounded-full bg-[#c4b5fd]"
              />
              <div>
                <div className="text-[15px] font-semibold text-white">Your files stay yours</div>
                <p className="mt-1 text-sm leading-6 text-zinc-400">
                  Keep project context, scripts, prompts, and outputs organized in one focused workspace.
                </p>
              </div>
            </li>
            <li className="grid grid-cols-[auto_1fr] items-start gap-5">
              <span
                aria-hidden="true"
                className="mt-2.5 inline-block h-1.5 w-1.5 rounded-full bg-[#c4b5fd]"
              />
              <div>
                <div className="text-[15px] font-semibold text-white">BYOK media APIs</div>
                <p className="mt-1 text-sm leading-6 text-zinc-400">
                  Configure image, video, and audio provider keys locally. Paid hosted features are hidden until the app is ready for them.
                </p>
              </div>
            </li>
          </ul>

        </div>
      </section>

      {/* ============================================================
          FOOTER — minimal
          ============================================================ */}
      <footer className="border-t border-white/5 py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-8 text-[12px] text-zinc-500">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anvil-logo.png" alt="" width={16} height={16} className="opacity-70" />
            <span>Anvil</span>
          </div>
          <div className="tracking-wider">Local desktop · $100 annual license</div>
        </div>
      </footer>
    </main>
  );
}
