# Security

Comfy Studio is intended for a trusted machine, private LAN, or private tailnet. It does not currently include application-level authentication. Do not expose it or ComfyUI directly to the public internet.

The web interface can submit generations, view history, interrupt jobs, and update connection settings. Anyone who can reach the service should therefore be treated as an authorized user.

API keys entered in Settings are stored locally in `data/settings.json` with owner-only permissions. The key is never returned to the browser. The entire `data/` directory is ignored by Git and must not be committed or included in release archives.

To report a vulnerability, open a private security advisory in the GitHub repository rather than a public issue.
