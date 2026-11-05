# Shuriken Studio

AI agents that build Roblox games inside Roblox Studio. Describe a game, and they plan it, build it, playtest it and fix what fails. Every 3D model is made in Kiln, which comes with it.

[Download](https://shuriken.studio/apps/shuriken-studio) · [Setup guide](docs/SETUP.md)

## You need

- Windows 11, 64-bit
- Roblox Studio, with its MCP server turned on
- Blender 5.2 LTS, for Kiln
- A Claude plan, or an Anthropic API key

Whole games use a lot of Claude usage. When you reach a limit, work waits and carries on when it resets.

## Install

1. Install [Blender 5.2 LTS](https://www.blender.org/download/).
2. Download the installer and run it. It installs Shuriken Studio, then Kiln. It isn't code-signed, so Windows may warn you: choose **More info → Run anyway** if you trust the release.
3. Open Shuriken Studio and go to **Settings → Claude login**. Sign in to Claude, or save an API key.
4. Check **Settings → Roblox & Studio**, then describe a game on the start page.

The full walkthrough is in the [setup guide](docs/SETUP.md).

## Updates

Shuriken Studio doesn't update itself. To get a newer version, download its installer and run it over the one you have: your games and settings stay.

## Build from source

Needs Node.js 24 or newer.

```powershell
npm ci
npm run dev
```

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Shuriken Studio is an independent project, not made or endorsed by Roblox Corporation or Anthropic.
