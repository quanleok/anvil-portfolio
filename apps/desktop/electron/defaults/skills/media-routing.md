---
name: media-routing
summary: Rules for routing image, video, music, and reference media through configured providers and the correct project destinations.
version: 1
triggers: ["generate_image", "generate_video", "generate_music", "stage_reference_media", "provider", "api key", "byok", "routing"]
crossRefs: ["image-generation"]
---

# Media routing

Use this skill whenever the task involves choosing a media provider, staging references, or deciding where generated media should be saved.

## Provider routing

- Settings -> API Keys capability checkboxes are routing gates.
- If a configured provider is keyed for Image, use that provider/tool first for image generation.
- Terminal-agent native image generation is fallback only after BYOK provider/API failure or when no matching BYOK provider is configured.
- Use the configured provider path before improvising a local workaround.

## Save destinations

- `generate_image`, `generate_video`, and `generate_music` save generated media into the project.
- Untargeted generated image/audio/reference files default to `assets/library/`.
- Direct save/bind is correct when the user names a target asset or asks to import/bind directly.
- Use `assets/inbox/` only as temporary trash/review when explicitly requested.
- Asset Context is text guidance only. Do not upload media into `.forge/asset-context/`.
- Do not write generated media directly into `assets/characters/`, `assets/locations/`, `assets/props/`, `assets/keyframes/`, or `assets/audio/` unless the user clearly asked for that target.

## Reference delivery

- EvoLink-style providers need a public HTTPS URL.
- Use `stage_reference_media(mode:"url")` or pass `imagePath` to `generate_video` after Bunny/public mirror staging is configured.
- Topview-style providers can use `stage_reference_media(mode:"upload")` with a local file path.
- If the provider cannot consume the current reference form, stage/convert it first instead of guessing.

## Targeting rule

- The user supplies the image description and style.
- This skill decides which provider path to use and where the resulting media belongs.
- Use the asset destination requested by the user and preserve existing references.
- For `characters`, `locations`, and `keyframes`, honor the asset `kind` (`single` vs `sheet`) before binding media.
- If the request clearly asks for a sheet variant and the target card is still `single`, create/update the asset entry to `kind:"sheet"` before direct binding.
- If the request clearly asks for a single variant, do not bind it into a `sheet` card unless the user explicitly wants that mixed behavior.
