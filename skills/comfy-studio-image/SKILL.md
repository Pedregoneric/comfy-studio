---
name: comfy-studio-image
description: Generate an image or video through a running Comfy Studio and ComfyUI installation and return the resulting media. Use when the user asks the agent to create, render, draw, visualize, or generate an image with their local models or LoRAs.
---

# Comfy Studio Image

Use the `generate_comfy_studio_image` MCP tool when available. Build `idea` from the user's request plus relevant character details already established in the conversation, memory, or supplied reference material; never discard those details. Leave `enhance` enabled unless the user provides a finished model-specific prompt. Omit `model` and `loras` by default so Comfy Studio selects suitable installed assets before writing the prompts. Pass model, LoRA, dimensions, seed, or sampling values only when explicitly requested or already established by context. Passing an empty `loras` array explicitly disables automatic LoRA selection.

For a named anime character, set `character_accuracy` to `strict canon` and `body_type` to `canon accurate` unless the user requests a reinterpretation or different build. Comfy Studio automatically adds the originating series art style when it does not conflict with an explicitly requested style. Include known LoRA activation words in each LoRA's `trigger` field; never guess an exact trigger.

## Original and obscure characters

Do not submit only a custom character's name. Models and prompt writers do not know private, original, or obscure identities and will otherwise produce a generic person.

Include as many known identity anchors as possible in `idea`:

- gender presentation, ancestry or complexion, plus age presentation only when the user explicitly provides it or it is essential to the design;
- height, body type, build, and distinctive proportions;
- face shape, eyes, brows, nose, lips, and characteristic expression;
- hair color, length, texture, style, bangs, and unusual features;
- signature clothes, colors, accessories, markings, scars, tattoos, ears, horns, wings, or other traits;
- personality conveyed through posture, gesture, and expression;
- requested pose, action, setting, camera, lighting, mood, and art style.

Keep each character's traits together when multiple people appear. Never invent details that contradict the user. If identity consistency is central and too few anchors are available, ask one concise question for the missing appearance/build details before generating. If the user says to improvise, choose one coherent design, state it concretely in `idea`, and reuse the same anchors in later images.

Treat this as one pipeline call: asset selection → prompt pair writing → ComfyUI generation → image delivery. Return the image content from the tool directly. Also report the chosen model, LoRAs, and seed briefly. The response contains both `prompt` and `negative`; retain them when the user asks for reproducibility. Do not claim success before the tool returns media.

If the MCP tool is unavailable, run `scripts/generate.py`. Set `COMFY_STUDIO_URL` when Comfy Studio is not at `http://127.0.0.1:3030`. The script downloads the first result and prints a `MEDIA:` line suitable for agent clients.

Examples:

```bash
python scripts/generate.py "a cozy cabin under the northern lights"
python scripts/generate.py "retro anime racer" --model illustrious --width 1216 --height 832
python scripts/generate.py "a named anime character in a garden" --body-type "canon accurate" --character-accuracy "strict canon"
python scripts/generate.py "finished, tag-based prompt" --no-enhance
```
