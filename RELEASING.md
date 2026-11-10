# Maintainer release guide

This document is for maintainers. **Nothing in this repository is automatically published to npm.**

## Current candidate

- Package: `dsh-memory-dream`
- Source version: `0.3.0` (`lib/index.js` must agree with `package.json`)
- Source: https://github.com/Kaito-Rowing/dsh-memory-dream
- Intended npm registry: https://registry.npmjs.org/

**Verify the npm name is still unclaimed immediately before your first publish:**

```bash
npm view dsh-memory-dream version
```

A 404 can indicate the name is available but is not a reservation. If another publisher owns it, **do not overwrite or impersonate them**; choose a distinct name or an npm scope you control, update the package, install commands and workflow, and create a new PR before publishing.

## Release gates

1. Review the code, privacy implications and [SECURITY.md](SECURITY.md). The default transcript reader must not widen a workspace-scoped request to other projects.
2. Check CI for Node 20/22/24; run a local smoke test in a disposable DSH profile and confirm that `memory_status`, a write/read cycle and `memory_dream` work as advertised.
3. Use Node 24 for publishing. Run `npm test`, `npm pack --dry-run`, and inspect the exact archive using `npm pack` and `tar -tf dsh-memory-dream-0.3.0.tgz`. Confirm there are no sessions, secrets, private snapshots, logs, or unwanted artifacts.
4. Check `package.json` `version`, `name`, `repository`, `exports`, `files`, `publishConfig` and the `PLUGIN_VERSION` constant. Update both READMEs and `CHANGELOG.md` if behavior changed.

## First npm publication (requires an npm account)

The first publish normally requires an npm owner to authenticate and claim the package. You can bootstrap from a clean checkout of the reviewed release commit:

```bash
npm login
npm whoami
npm test
npm pack --dry-run
npm publish --access public
npm view dsh-memory-dream@0.3.0 version
```

The registry may ask for 2FA. **Do not send your npm password, token, OTP or recovery codes to a chat or commit them to GitHub.** Record a published version only after `npm view` confirms it. If the package already exists and you do not own it, stop.

## GitHub Release

After checks and initial npm publication, tag the **same reviewed commit** and create a GitHub Release:

```bash
git switch main
git pull --ff-only
git tag v0.3.0
git push origin v0.3.0
gh release create v0.3.0 --title "dsh-memory-dream v0.3.0" --notes-file docs/releases/v0.3.0.md
```

Confirm `git rev-parse v0.3.0` points at the intended commit. Do not recreate an existing tag without assessing the impact. Include the exact commit and installed package version in a release announcement.

## Future npm releases: tokenless trusted publishing

After an npm package exists, configure its **Trusted Publisher** on npmjs.com (package settings):

- Provider: GitHub Actions
- GitHub owner: `Kaito-Rowing`
- Repository: `dsh-memory-dream`
- Workflow filename: `npm-publish.yml`
- Allowed action: **npm publish** (not just npm stage publish)
- Optional environment: leave blank unless you also configure the exact environment in the workflow.

The manual `.github/workflows/npm-publish.yml` uses GitHub OIDC to avoid persistent npm write tokens. It **does not run on push, tag creation or release publication**. Once the npm trust configuration is verified, start it manually via Actions, supplying the existing version tag. The workflow checks the tag's package version and runs tests before publishing. Use it for **future, not yet published versions**; attempting to republish `0.3.0` will fail.

Trusted publishing currently requires npm CLI >=11.5.1 and Node >=22.14.0. Its first configured workflow run must succeed within the npm trust setup window; see [npm documentation](https://docs.npmjs.com/trusted-publishers/). A successful GitHub Release alone does not publish to npm.

## Community announcement

After both distribution channels are confirmed, use [the discussion draft](docs/community-announcement.md) in [DSH's Show Your Plugins! category](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins). Add the `dsh-plugin` GitHub repository topic. Never link the private debug snapshot.
