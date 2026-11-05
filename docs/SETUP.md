# Setup guide

From a fresh Windows PC to your first game, in about 25 minutes (most of it downloads).

## What you need

- A Windows 11 PC (64-bit) with about 4 GB free, plus room for Roblox Studio. A graphics card helps: Kiln renders on it.
- A Roblox account (free).
- Claude: a Claude plan, or an Anthropic API key. Whole games use a lot of usage, so a bigger plan lets a build finish without waiting for limits to reset.

## Install

1. **Roblox Studio.** Download it from create.roblox.com, install it, open it and sign in with your Roblox account.
2. **Blender 5.2.** Download Blender 5.2 LTS from blender.org and install it with the default options. Kiln runs it in the background, so you never need to open it.
3. **Shuriken Studio and Kiln.** Download the installer from https://shuriken.studio/apps/shuriken-studio (or this repository's Releases) and run it. It installs Shuriken Studio, then Kiln, for your Windows account. Already have Kiln? It's left as it is.

The installer isn't code-signed yet, so Windows may show **Windows protected your PC**: choose **More info**, then **Run anyway**.

## Claude login

Open **Settings → Claude login** and choose how Shuriken Studio signs in to Claude:

- **This PC's Claude login** (the default): the Claude Code login already on this PC. Kiln uses it too.
- **Shuriken's own Claude login**: a separate login used only by Shuriken.
- **Anthropic API key**: paste a key and press **Save key**. Runs are paid per use from your API credits, and the key is kept encrypted on this PC.

To sign in, press **Sign in** on the login's card. Claude Code's sign-in opens in the window: choose **Claude account with subscription**, finish in the browser that opens, then press **Check sign-in**. Shuriken never sees your password.

Press **Use this** to switch to another option. A build that's running carries on, and its next agent uses the new login.

When the login reaches its usage limit, work waits and carries on by itself when the limit resets. If the login expires or is signed out, the team pauses until you sign in again.

## Roblox Studio

In Roblox Studio, open **Assistant → Manage MCP Servers** and turn on **Enable Studio as MCP server**. It's how Shuriken works inside Studio, and it stays on.

The first time Shuriken connects, it also installs a small Studio plugin, Shuriken Link. It only talks to Shuriken on this PC.

Then open **Settings → Roblox & Studio** in Shuriken: Studio should show as connected. You don't need to open a place yourself, because Shuriken opens Studio on each game.

To build your first game, describe it on the start page in a sentence or two, for example: "A round-based obby race for up to 8 players, with checkpoints and a coin shop."

## Kiln

Kiln makes every 3D model in your games. When a game needs a model, Shuriken starts Kiln in the background and sends it a brief, and the model comes back into Studio. Kiln builds on the same Claude login as Shuriken. You can also open Kiln from the Start menu to model anything yourself.

If Kiln can't be reached, the build pauses and the director's chat says why. It carries on by itself as soon as Kiln answers again. To keep going without it, press **Run anyway (reduced quality)**: Shuriken's own Blender builds the models until Kiln is back.

## Questions

**Windows says "Windows protected your PC"**

The installer isn't code-signed yet. Choose More info, then Run anyway.

**Studio doesn't show as connected**

Check that Enable Studio as MCP server is on (Assistant → Manage MCP Servers), then close Studio and let Shuriken open it again. Studio has to be signed in.

**The build paused because of Kiln**

Open Kiln once from the Start menu, then wait: the build carries on when Kiln answers. Installed Kiln somewhere else? Set its location in Settings → 3D models & Kiln. Kiln also needs Blender 5.2.

**"Not signed in" or a limit reached**

Settings → Claude login shows the login in use, whether it's signed in, and its usage. Sign in again from its card. At a limit, work waits for the reset, or press Resume afterwards if you turned off "Resume automatically when the limit resets".

**Where are my games?**

In Documents\Shuriken Studio\Projects. Settings and logs are in %APPDATA%\Shuriken Studio.

**How do I get a newer version?**

Shuriken Studio doesn't update itself. Download the newest installer and run it over the one you have: your games, projects and settings stay.

**How do I uninstall it?**

Windows Settings → Apps → Installed apps: Shuriken Studio and Kiln are uninstalled separately. Your games, projects and settings stay.

Still stuck? Open an issue in this repository.
