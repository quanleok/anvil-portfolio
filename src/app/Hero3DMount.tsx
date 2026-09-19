"use client";

import dynamic from "next/dynamic";

// Tiny client-side wrapper so we can use `dynamic(...,{ssr:false})` —
// Next 16 forbids ssr:false in server components, so the page (which
// stays a server component for SEO + edge perf) imports this stub,
// and this stub does the dynamic import. Splits the R3F bundle out of
// the initial HTML payload.
const Hero3D = dynamic(() => import("./Hero3D"), { ssr: false });

export default function Hero3DMount() {
  return <Hero3D />;
}
