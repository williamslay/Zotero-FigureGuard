# Releasing FigureGuard

This guide covers publishing a version of FigureGuard as a GitHub Release with a
downloadable `.xpi`. Version numbers are bumped by hand. No workflow bumps the
version, and no workflow publishes on every push to `main`.

## Branches

| Branch | Contents |
| --- | --- |
| `main` | Public release branch. Source, tests, user-facing docs. Tags live here. |
| `dev` | Full development history, including internal design notes and the round-by-round log in `reports/`. |

Land work on `dev`, then sync it to `main` before tagging. The two branches have
separate histories, so sync by cherry-pick or by squashing `dev` into one commit
on `main`.

## When to bump the version

- Detection or rendering behaviour that a user can notice: bump the patch number
  (`0.1.31` → `0.1.32`).
- New user-facing feature: bump the minor number while the major stays `0`.
- A breaking change in the installed add-on, such as a new minimum Zotero
  version: bump to `0.2.0` or `1.0.0`.
- A CI, documentation, or tooling-only change does not need a new release unless
  you want to re-package the add-on.

One tag means one version. Never re-point an existing tag at different code, and
never re-use a version number.

## Update the version fields

Four values must agree. For version `0.1.32`:

| Place | Field |
| --- | --- |
| Git tag | `v0.1.32` |
| `package.json` | `"version": "0.1.32"` |
| `package-lock.json` | top-level `"version"` and `packages[""].version` |
| `manifest.json` | `"version": "0.1.32"` |

Run:

```bash
npm version 0.1.32 --no-git-tag-version --allow-same-version=false
```

That updates `package.json` and `package-lock.json` only. Then edit
`manifest.json` by hand. `npm run build` refuses to package when these files
disagree, and the Release workflow checks the tag against them too.

The add-on ID in `manifest.json` (`figure-color-preservation@local`) does not
change between releases.

## Run the local checks

`zip` and `unzip` must be installed. On Debian or Ubuntu: `sudo apt install zip unzip`.

```bash
npm ci                 # install exactly what package-lock.json pins
npm run test:ci        # PDF-free suite; must report 0 cancelled
npm test               # full regression, needs the five fixture PDFs (see README)
npm run build          # → dist/figure-color-preservation-<version>.xpi
node scripts/verify-xpi.mjs
```

`scripts/verify-xpi.mjs` inspects the built archive, prints its SHA-256, and
writes `dist/SHA256SUMS.txt`. Any failed check exits non-zero.

## Create and push the tag

Commit the version bump on `main`, push it, then tag the pushed commit:

```bash
git switch main
git commit -am "chore: release 0.1.32"
git push origin main
git tag -a v0.1.32 -m "Zotero FigureGuard 0.1.32"
git push origin v0.1.32
```

Pushing the tag is what starts the Release workflow. The workflow refuses to
publish a tag that is not part of `main`'s history, so tagging a `dev` commit
fails fast instead of releasing unreleased code.

## Watch the workflow

GitHub → the repository → **Actions** tab → **Release** in the left sidebar → the
run named `v0.1.32`.

- Green: the release exists.
- Red: open the failed job and read the step name. The version-consistency step
  prints every field and value it compared.

The CI workflow runs on every pull request and on every push to `main` or `dev`.
It builds the XPI and stores it as an Actions artifact, but it never creates a
release.

## Verify the release

On the release page for `v0.1.32` you should see exactly two assets:

```text
figure-color-preservation-0.1.32.xpi
SHA256SUMS.txt
```

While the project is in `0.1.x`, the release is marked **Pre-release**. Stable
releases are marked the ordinary way.

Check the download locally:

```bash
sha256sum -c SHA256SUMS.txt          # run in the directory holding both files
unzip -l figure-color-preservation-0.1.32.xpi
```

The archive must contain only `manifest.json`, `bootstrap.js`, and
`content/index.js`. Install it through Zotero → Tools → Add-ons → gear icon →
**Install Plugin From File…**, then confirm the add-on manager lists
`Figure Color Preservation` at version `0.1.32`.

## When a release fails

| Situation | What to do |
| --- | --- |
| Version fields disagree | Fix the fields on `main`, commit, move your new tag to that commit, push again. |
| Test step is red | Fix the tests on `main`, then tag a new version. Do not push a second tag for the same version. |
| Release with the same name already exists | `gh release view v0.1.32` shows it. Delete it with `gh release delete v0.1.32 --yes` (this keeps the tag), or use a new version number. The workflow does not overwrite an existing release's assets. |
| `GITHUB_TOKEN` lacks write access | See the settings below. |
| Tag pointed at the wrong commit | Delete the tag locally and remotely (`git push origin :refs/tags/v0.1.32`), then re-tag the right commit — only while no release has been published from it. |

To retry publishing without pushing a new tag, use **Actions** → **Release** →
**Run workflow**, and type the existing tag name (for example `v0.1.32`) into the
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
`"update_url": "https://www.zotero.org/update/figure-color-preservation"`. That
path returns an HTML 404 page, not a JSON update manifest, so Zotero does not
currently detect new GitHub Releases inside the app. Publishing to Releases is
not the same as in-app auto-update. A future change can point `update_url` at a
generated `updates.json` served by GitHub Pages; the URL has to name the manifest
file itself.
