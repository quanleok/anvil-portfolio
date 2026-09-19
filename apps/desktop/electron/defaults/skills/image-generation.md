---
name: image-generation
version: 2
triggers: ["image", "generate image", "character", "location", "prop", "keyframe", "reference", "storyboard", "sheet", "panel"]
summary: Public example of using the workspace image tools with user-provided prompts and destinations.
crossRefs: ["media-routing"]
---

# Image tools

This public example provides tool usage guidance. It does not provide a creative
production method, visual style preset, or prompt recipe.

- Use the user's requested subject, style, composition, and references. Do not
  substitute a fixed aesthetic or require a planning sequence.
- Check the configured image provider and its supported inputs. Ask before a
  paid operation unless the user has already authorized it.
- Use `generate_image` for a requested generation. Report provider errors and
  the returned file path accurately; do not claim success without a result.
- A user-selected asset can receive media through the existing asset tools.
  Preserve its identity and select the matching `kind` (`single` or `sheet`).
- If no target asset is specified, use the media library. Do not create extra
  cards, cut panels, or attach references unless the user requests those changes.
- Existing image-editing, cropping, and binding tools remain available for
  explicit requests. Preserve source media and report the changed paths.

See `media-routing` for provider configuration and supported save destinations.
