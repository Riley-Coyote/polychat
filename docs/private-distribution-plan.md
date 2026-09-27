# Polychat Private Distribution Plan

**Status:** Deferred  
**Recorded:** August 2026  
**Resume phrase:** “Resume the Polychat private distribution plan.”

## Purpose

Share Polychat as an easy-to-install product without publishing its development source as an open-source repository. The goal is reasonable practical and legal protection, not perfect resistance to reverse engineering.

Polychat should remain local-first. This distribution work must not introduce hosted transcripts, provider credential storage, telemetry, mandatory accounts, or a model API proxy.

## Chosen approach

Use a private source repository and a separate public, binary-only download repository.

### Private source repository

The existing `Riley-Coyote/polychat` repository becomes private and remains the canonical development repository. It contains:

- TypeScript and React source
- Broker, MCP, and runtime adapter implementations
- Tests and fixtures
- Build and release automation
- Development documentation and commit history

Changing the existing repository to private is preferable to deleting and recreating it because it preserves the history, tags, issues, and remote configuration. Before any currently local v1.1 work is pushed, verify that the repository is private.

### Public download repository

Create a separate repository such as `Riley-Coyote/polychat-downloads`. It contains no original application source, tests, or development history. It may contain:

- A product README
- Installation and troubleshooting instructions
- Release notes and checksums
- A small installer or launcher
- Proprietary license and privacy terms
- Packaged release artifacts

GitHub Releases provides versioned file hosting. A future Polychat website can point its **Download for Mac** button directly at the latest release artifact.

## User experience

The intended installation flow is:

1. Visit the Polychat website or downloads page.
2. Select **Download for Mac**.
3. Open the downloaded Polychat installer.
4. The installer places Polychat’s bundled runtime and browser assets in a stable application-support location.
5. The installer registers the local Polychat marketplace/plugin with installed Codex and Claude Code hosts.
6. The user restarts Codex or Claude Code.
7. `$council` and `/council` become available.

The installer should detect missing hosts and explain them without failing the installation. Codex, Claude Code, Grok, and Kimi authentication remain owned by their respective CLIs.

Updates are manual for the first distributable version: download and run the newer installer. Reinstallation must preserve rooms, transcripts, preferences, and native runtime session bindings under `~/Library/Application Support/Polychat/`.

## Package contents

The release package includes only what is needed to run Polychat:

- Bundled and minified broker executable or JavaScript bundle
- Bundled MCP server
- Compiled browser UI assets
- Codex and Claude plugin manifests
- The shared council skill
- Local marketplace metadata
- Installer and uninstaller instructions
- License, privacy notice, version metadata, and checksums

The release package excludes:

- `src/`
- Tests and fixtures
- Source maps
- Development configuration that is not required at runtime
- Repository history
- Riley-specific paths, sessions, rooms, credentials, logs, or local data

The initial release may continue using the existing compiled Node bundles. A Node single executable or native Rust/Swift core is an optional later hardening step, not a prerequisite for sharing Polychat.

## Licensing

Future private-distribution releases will not use MIT.

Replace the repository and manifest references to MIT with a proprietary license. At minimum, the distributed package should state that Polychat is copyrighted, licensed for use by the recipient, and may not be redistributed, resold, republished, or used to create derivative products without written permission.

Use a reviewed EULA before a broad commercial release. For an early trusted beta, a concise proprietary `LICENSE.txt` and acceptance during installation are sufficient. Do not add licensing accounts, activation servers, telemetry, or remote kill switches in the first iteration.

The already published MIT v1.0.0 remains historically MIT-licensed. The practical objective is to keep future work and releases private rather than attempting to revoke that earlier grant.

## Protection layers

This plan deliberately provides modest, practical protection:

1. The development repository is private.
2. Users receive no clean TypeScript/React source or test suite.
3. Users receive no development history or convenient source repository to fork.
4. Runtime code is bundled and minified without source maps.
5. Distribution carries explicit proprietary terms.
6. Later releases may be signed and notarized to establish publisher identity and protect release integrity.

Installed software can ultimately be inspected. Perfect secrecy is not an acceptance requirement.

## Implementation phases

### Phase 1 — Protect the source

- Make `Riley-Coyote/polychat` private.
- Confirm anonymous access no longer works.
- Preserve the existing local worktree and repository history.
- Replace MIT references with future proprietary licensing terms.
- Remove public-source installation instructions from the development README.
- Confirm no current v1.1 source was pushed before the visibility change.

### Phase 2 — Produce a clean runtime bundle

- Define a reproducible production bundle containing the broker, MCP server, UI, manifests, skill, and required assets.
- Disable source maps and development-only output.
- Add an artifact audit that rejects source files, credentials, absolute user paths, runtime data, logs, and development fixtures.
- Generate checksums and a version manifest.
- Verify that Polychat runs from the packaged location rather than the development checkout.

### Phase 3 — Build the installer

- Create the simplest reliable macOS installer, initially a packaged installer or signed installation script.
- Install runtime files into a stable Polychat application-support directory.
- Register local marketplaces/plugins for Codex and Claude Code.
- Detect installed hosts and show actionable guidance for missing hosts.
- Preserve application data during upgrades.
- Include clear removal instructions that do not delete saved rooms unless the user explicitly requests it.

### Phase 4 — Create the download channel

- Create the public binary-only `polychat-downloads` repository.
- Publish versioned release artifacts and checksums through GitHub Releases.
- Add a minimal product/download page or website that links to the latest artifact.
- Keep the public repository free of application source and source maps.
- Document manual upgrade and troubleshooting steps.

### Phase 5 — Release hardening

- Sign and notarize the macOS distribution when the Apple Developer credentials are available.
- Test installation on a clean second Mac and a fresh macOS user account.
- Verify Codex and Claude Code installation, `$council`, `/council`, broker startup, browser launch, runtime detection, saved-room persistence, and upgrade behavior.
- Confirm the distributed files contain no Riley-specific paths, credentials, rooms, sessions, or logs.

## Verification checklist

- [ ] Anonymous visitors cannot access the source repository.
- [ ] The public download repository contains no original application source or source maps.
- [ ] A new user can install Polychat without Git, cloning a repository, or running `npm install`.
- [ ] Codex and Claude Code can discover the installed plugin after their documented restart/reload step.
- [ ] `$council` and `/council` open the same local Polychat runtime.
- [ ] Optional Grok and Kimi peers remain detectable when installed.
- [ ] Rooms and transcripts survive an application upgrade.
- [ ] Uninstalling runtime files does not silently erase user data.
- [ ] Packaged releases contain the proprietary license and privacy explanation.
- [ ] Release artifacts contain no development source, source maps, secrets, personal paths, or runtime data.
- [ ] A clean second-Mac installation succeeds.

## Decisions intentionally deferred

These choices are not required until implementation begins:

- Final product website and domain
- Free, invite-only, or paid initial distribution
- Whether the first beta uses a simple signed installer or a polished `.pkg`
- Whether signing and notarization are required for the first trusted beta or the following public release
- Whether automatic updates are worth adding after manual distribution is proven
- Whether later hardening should use a Node single executable, Rust, Swift, or remain bundled JavaScript

## Resume checklist

When this work resumes:

1. Read this document and inspect the live repository, remote visibility, worktree, tags, and release state.
2. Preserve all uncommitted Polychat work before changing repository visibility or licensing.
3. Make the source repository private before pushing unpublished work.
4. Confirm the desired initial audience: trusted beta, free public download, or paid release.
5. Implement the phases above in order, ending with a clean-Mac installation test.

