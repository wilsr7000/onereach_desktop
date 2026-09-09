/**
 * The update feed, as code (ADR-101).
 *
 * electron-updater learns where to look from `app-update.yml`, a file the
 * packager writes into the bundle — for release targets. The fast
 * `--dir` build never wrote it, a bundle from that path was installed on
 * 2026-09-09, and "Check for Updates" died with ENOENT. Updating must
 * work in every build that reaches /Applications, so the feed is a
 * constant here: the updater sets it from code at startup and writes the
 * descriptor itself when the bundle has none; the packager hook and the
 * release gate keep the file in every bundle anyway (belt and braces).
 *
 * Pure: no Electron imports (tests and the packaging hook read it too).
 */

export const LITE_UPDATE_FEED = {
  provider: 'github',
  owner: 'wilsr7000',
  repo: 'Onereach_Lite_Desktop_App',
  /**
   * Where electron-updater stages downloads: ~/Library/Caches/<this>/.
   * electron-builder derives it as `<package name>-updater`; it is part
   * of the install handoff (scripts/install-update.sh finds the pending
   * bundle there), so it is pinned, not derived.
   */
  updaterCacheDirName: 'onereach-lite-updater',
} as const;

/** The exact `app-update.yml` electron-builder writes for this feed. */
export function feedDescriptorYaml(): string {
  return (
    `owner: ${LITE_UPDATE_FEED.owner}\n` +
    `repo: ${LITE_UPDATE_FEED.repo}\n` +
    `provider: ${LITE_UPDATE_FEED.provider}\n` +
    `updaterCacheDirName: ${LITE_UPDATE_FEED.updaterCacheDirName}\n`
  );
}

/** The human-facing releases page for the same feed. */
export function releasesUrl(): string {
  return `https://github.com/${LITE_UPDATE_FEED.owner}/${LITE_UPDATE_FEED.repo}/releases`;
}
