import anvilLogoUrl from "../assets/anvil-logo.webp";
import anvilLogoUrl2x from "../assets/anvil-logo@2x.webp";
import anvilHammerUrl from "../assets/anvil-hammer.webp";
import anvilHammerSmUrl from "../assets/anvil-hammer-sm.webp";
import { useReducedMotion } from "../hooks/useReducedMotion";
import animeDirectorUrl from "../assets/ui-pack/avatars/anime-director.webp";
import documentaryDirectorUrl from "../assets/ui-pack/avatars/documentary-director.webp";
import fantasyDirectorUrl from "../assets/ui-pack/avatars/fantasy-director.webp";
import horrorDirectorUrl from "../assets/ui-pack/avatars/horror-director.webp";
import noirDirectorUrl from "../assets/ui-pack/avatars/noir-director.webp";
import scifiDirectorUrl from "../assets/ui-pack/avatars/scifi-director.webp";

type AnvilMarkVariant = "static" | "idle" | "hammer" | "director";
export type AgentAvatarId = "anvil" | "fantasy" | "anime" | "scifi" | "noir" | "horror" | "documentary";

export const AGENT_AVATAR_OPTIONS: Array<{ id: AgentAvatarId; label: string }> = [
  { id: "anvil", label: "Anvil" },
  { id: "fantasy", label: "Fantasy director" },
  { id: "anime", label: "Anime director" },
  { id: "scifi", label: "Sci-fi director" },
  { id: "noir", label: "Noir director" },
  { id: "horror", label: "Horror director" },
  { id: "documentary", label: "Documentary director" },
];

const DIRECTOR_AVATAR_SRC: Record<AgentAvatarId, string> = {
  anvil: anvilLogoUrl,
  fantasy: fantasyDirectorUrl,
  anime: animeDirectorUrl,
  scifi: scifiDirectorUrl,
  noir: noirDirectorUrl,
  horror: horrorDirectorUrl,
  documentary: documentaryDirectorUrl,
};

interface AnvilMarkProps {
  size?: number;
  variant?: AnvilMarkVariant;
  avatarId?: AgentAvatarId;
}

export function AnvilMark({ size = 22, variant = "static", avatarId = "anvil" }: AnvilMarkProps) {
  const reducedMotion = useReducedMotion();

  // Reduced-motion users get a static body for working-state variants —
  // CSS pauses the ring rotation but APNG pixel animation can't be paused
  // with @media (prefers-reduced-motion).
  if (reducedMotion && (variant === "idle" || variant === "hammer")) {
    if (avatarId === "anvil") {
      return (
        <img
          className="anvil-mark"
          src={anvilLogoUrl}
          srcSet={`${anvilLogoUrl} 1x, ${anvilLogoUrl2x} 2x`}
          width={size}
          height={size}
          alt=""
          aria-hidden
          draggable={false}
        />
      );
    }
    return (
      <img
        className="anvil-mark anvil-mark-director"
        src={DIRECTOR_AVATAR_SRC[avatarId]}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
      />
    );
  }

  if (variant === "idle") {
    // While agent is working: render the same artwork as the static
    // avatar. The "working" pulse is owned by the surrounding container
    // (e.g. `.project-terminal-avatar` border flash), not a ring overlay.
    if (avatarId === "anvil") {
      return (
        <img
          className="anvil-mark"
          src={anvilLogoUrl}
          srcSet={`${anvilLogoUrl} 1x, ${anvilLogoUrl2x} 2x`}
          width={size}
          height={size}
          alt=""
          aria-hidden
          draggable={false}
        />
      );
    }
    return (
      <img
        className="anvil-mark anvil-mark-director"
        src={DIRECTOR_AVATAR_SRC[avatarId]}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
      />
    );
  }
  if (variant === "hammer") {
    // Character swinging a hammer — used as the chat assistant avatar while working.
    return (
      <img
        className="anvil-mark anvil-mark-hammer"
        src={size <= 16 ? anvilHammerSmUrl : anvilHammerUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
      />
    );
  }
  if (variant === "director") {
    if (avatarId === "anvil") {
      return (
        <img
          className="anvil-mark"
          src={anvilLogoUrl}
          srcSet={`${anvilLogoUrl} 1x, ${anvilLogoUrl2x} 2x`}
          width={size}
          height={size}
          alt=""
          aria-hidden
          draggable={false}
        />
      );
    }
    return (
      <img
        className="anvil-mark anvil-mark-director"
        src={DIRECTOR_AVATAR_SRC[avatarId]}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
      />
    );
  }
  return (
    <img
      className="anvil-mark"
      src={anvilLogoUrl}
      srcSet={`${anvilLogoUrl} 1x, ${anvilLogoUrl2x} 2x`}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}
