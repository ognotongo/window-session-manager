/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// web-ext targets Firefox and lints/builds from the project root. Keep it
// focused on the Firefox extension by ignoring the cross-browser tooling and
// build output (the Chrome manifest, the build script, dist/, screenshots).
module.exports = {
  ignoreFiles: [
    "dist",
    "manifest.chrome.json",
    "build.js",
    "web-ext-config.cjs",
    "Screenshot*.png",
    "**/Thumbs.db",
    "**/Desktop.ini",
  ],
};
