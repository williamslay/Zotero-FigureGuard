# Releasing Zotero Figure Guard

This guide covers the branch model, how a version number is chosen, and how a
version becomes a GitHub Release with a downloadable `.xpi`. Version numbers are
bumped by hand. No workflow bumps a version, and no workflow publishes on every
push to `main`.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | The only long-lived public branch. Source, tests, user-facing docs. Version tags live here. |
| `feature/*` | Short-lived branch cut from `main` for one feature. Opened as a pull request, merged with CI green, then deleted. |
| `internal` | Archive of the pre-open-source history, including the internal design notes in `docs/` and the round-by-round log in `reports/`. Not built by CI. |

The work flow for a feature:

1. `git switch -c feature/<topic>` from an up to date `main`.
2. Develop and push, then open a pull request into `main`. The pull request runs
   the CI gate.
3. Merge. The merge commit runs CI again on `main`. Delete the feature branch.
4. Install the CI artifact on a real Zotero and accept the feature.

## How a version number is chosen

A version number follows a feature, not a build. Merging does not consume a
version, and neither does installing a test build.

- Cut a release when a set of merged features has been accepted on a real Zotero
  installation.
- New user-facing features: raise the minor number. A fix on top of a released
  version: raise the patch number. `v0.6.0` then `v0.6.1`.
- Test builds need no version of their own. Every pull request and every merge to
  `main` stores a CI artifact named after the run and the commit, for example
  `zotero-figure-guard-run12-1a2b3c4`. Install that artifact to try a
  feature before it is released.

One tag means one version. Never re-point an existing tag at different code, and
never re-use a version number.

## Update the version fields

Four values must agree. For version `0.6.0`:

| Place | Field |
| --- | --- |
| Git tag | `v0.6.0` |
| `package.json` | `"version": "0.6.0"` |
| `package-lock.json` | top-level `"version"` and `packages[""].version` |
| `manifest.json` | `"version": "0.6.0"` |

Run:

```bash
npm version 0.6.0 --no-git-tag-version
```

That updates `package.json` and `package-lock.json` only. Then edit
`manifest.json` by hand. `npm run build` refuses to package when these four
disagree, and the Release workflow checks the tag against them too.

The add-on ID in `manifest.json` (`figure-guard@zotero.org`) does not
change between releases.

`.github/workflows/release.yml` carries a default value for the manual `tag`
input. It is a convenience for the run dialog only. Update it when it becomes
stale, or type the tag by hand when you start the workflow.

## Run the local checks

`zip` and `unzip` must be installed. On Debian or Ubuntu: `sudo apt install zip unzip`.

```bash
npm ci                                        # install exactly what package-lock.json pins
npm run test:ci                               # PDF-free suite; must report 0 cancelled
npm test                                      # full regression, needs the five fixture PDFs
npm run build                                 # → dist/zotero-figure-guard-0.6.0.xpi
node scripts/verify-xpi.mjs --expect-version 0.6.0
```

`scripts/verify-xpi.mjs` inspects the built archive, prints its SHA-256, and
writes `dist/SHA256SUMS.txt`. Any failed check exits non-zero. The archive is not
byte-reproducible, because `zip` stores a timestamp, so the hash belongs to the
build that produced it.

## Create and push the tag

Commit the version bump on `main`, push it, then tag the pushed commit:

```bash
git switch main
git commit -am "chore: release 0.6.0"
git push origin main
git tag -a v0.6.0 -m "Zotero Figure Guard 0.6.0"
git push origin v0.6.0
```

Pushing the tag is what starts the Release workflow. The workflow refuses a tag
that is not part of `main`'s history, so tagging a commit on another branch fails
fast instead of releasing code nobody merged.

## What the Release workflow does

1. Checks the tag name has the form `vMAJOR.MINOR.PATCH`.
2. Checks the tag exists on the remote. A mistyped tag fails here and the error
   lists the version tags that really exist.
3. Checks out the tag and refuses a tag outside `main`'s history.
4. Runs `npm ci`, `npm run test:ci`, and `npm run build`.
5. Verifies the archive and the four version fields, and writes
   `dist/SHA256SUMS.txt`.
6. Refuses to publish when a release for the tag already exists, so an existing
   release is never silently overwritten.
7. Runs `gh release create <tag> <xpi> dist/SHA256SUMS.txt --verify-tag
   --generate-notes`.

A version tag pushed to the repository is published as a **formal** release. To
publish a pre-release, start the workflow by hand — **Actions** → **Release** →
**Run workflow** — and tick **Mark the published release as a pre-release**. To
change the mark afterwards: `gh release edit v0.6.0 --prerelease` to set it,
`gh release edit v0.6.0 --prerelease=false` to clear it. The JSON field printed by
the workflow is `isPrerelease`, not `prerelease`.

## Watch the workflow

GitHub → the repository → **Actions** tab → **Release** in the left sidebar → the
run named `v0.6.0`.

- Green: the release exists.
- Red: open the failed job and read the step name. The version-consistency step
  prints every field and value it compared.

The CI workflow runs on every pull request into `main` and on every push to
`main`. It builds the XPI and stores it as a CI artifact, but it never creates a
release.

## Verify the release

On the release page for `v0.6.0` you should see exactly two assets:

```text
zotero-figure-guard-0.6.0.xpi
SHA256SUMS.txt
```

Check the download locally:

```bash
sha256sum -c SHA256SUMS.txt          # run in the directory holding both files
unzip -l zotero-figure-guard-0.6.0.xpi
```

The archive must contain only `manifest.json`, `bootstrap.js`,
`content/index.js`, and `content/figureguard-icon.svg`. Install it through
Zotero → Tools → Add-ons → gear icon → **Install Plugin From File…**, then
confirm the plug-in list shows `Zotero Figure Guard` at version `0.6.0` with
its icon beside the name, and that the reader toolbar control is the text
button `原色`.

## When a release fails

| Situation | What to do |
| --- | --- |
| `Tag vX.Y.Z does not exist on the remote` | The manual input was mistyped. Run the workflow again with a tag from the list in the error message. |
| Version fields disagree | Fix the fields on `main`, commit, move your new tag to that commit, push again. |
| Test step is red | Fix the tests on `main`, then tag a new version. Do not push a second tag for the same version. |
| Release with the same name already exists | `gh release view v0.6.0` shows it. Delete it with `gh release delete v0.6.0 --yes` (this keeps the tag), or use a new version number. The workflow never overwrites an existing release's assets. |
| `GITHUB_TOKEN` lacks write access | See the settings below. |
| `Publish the release` is red while the release page already shows both assets | `gh release create` succeeded and a later command in the same step failed. Check `gh release view <tag>`, fix the step, and retry with a dispatch run after deleting the release. |
| Tag pointed at the wrong commit | Delete the tag locally and remotely (`git push origin :refs/tags/v0.6.0`), then re-tag the right commit — only while no release has been published from it. |

To retry publishing without pushing a new tag, use **Actions** → **Release** →
**Run workflow**, and type the existing tag name (for example `v0.6.0`) into the
`tag` input. That is the only manual entry point, and it never creates a tag.

## GitHub settings

The workflows need no Personal Access Token and no external server. They use the
built-in `GITHUB_TOKEN`.

- GitHub → **Settings** → **Actions** → **General** → **Workflow permissions**.
  Either setting works, because `release.yml` declares
  `permissions: contents: write` for itself. **Read repository contents** is the
  more conservative choice.
- GitHub → **Settings** → **Branches**. Branch protection is not enabled for
  `main` in this repository. Enabling "Require a check to pass" for `ci.yml` is a
  deliberate choice by the maintainer, not a requirement of these workflows.
- GitHub → **Settings** → **Actions** → **General** → **Artifact and log
  retention** controls how long CI artifacts stay downloadable.
- The `main` branch is the repository default branch: **Settings** → **Branches**
  → **Default branch**.

## In-app automatic updates

`manifest.json` declares
`"update_url": "https://williamslay.github.io/Zotero-FigureGuard/updates.json"`.

For every formal (non-prerelease) release, `.github/workflows/release.yml` runs
`scripts/generate-updates-json.mjs` after creating the GitHub Release and
pushes the updated `updates.json` (preserving prior release entries and adding
the new version's `update_link` and `sha256` `update_hash`) to the `gh-pages`
branch without touching `main`.

One-time repository setup in GitHub:

- GitHub → **Settings** → **Pages** → **Build and deployment** → Source:
  **Deploy from a branch**, Branch: **`gh-pages`** / **`(root)`**.

Once GitHub Pages is enabled and at least one formal release after this change
has been published, Zotero installations carrying this `update_url` will detect
newer releases inside Zotero's Add-ons Manager.
