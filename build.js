#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

/*
 * Assemble a per-browser, loadable extension folder under dist/<target>/.
 *
 * The source files are shared; only the manifest differs (Firefox uses an
 * event-page background + sidebar_action; Chrome/Edge use a service worker +
 * side_panel). Each target's manifest source is copied in as manifest.json.
 *
 *   node build.js            # builds both targets
 *   node build.js chrome     # builds dist/chrome  (load this in Edge)
 *   node build.js firefox    # builds dist/firefox
 */

const fs = require("fs");
const path = require("path");

const SHARED = ["background.js", "sidebar", "options", "icons", "LICENSE"];
const MANIFESTS = {
  firefox: "manifest.json",
  chrome: "manifest.chrome.json",
};

function build(target) {
  const manifestSrc = MANIFESTS[target];
  if (!manifestSrc) {
    console.error(`Unknown target "${target}". Use: firefox | chrome`);
    process.exitCode = 1;
    return;
  }
  const outDir = path.join("dist", target);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const item of SHARED) {
    if (fs.existsSync(item)) {
      fs.cpSync(item, path.join(outDir, item), { recursive: true });
    }
  }
  fs.copyFileSync(manifestSrc, path.join(outDir, "manifest.json"));
  console.log(`Built ${target} -> ${outDir}`);
}

const targets = process.argv.slice(2);
(targets.length ? targets : Object.keys(MANIFESTS)).forEach(build);
