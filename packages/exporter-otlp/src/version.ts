// SPDX-License-Identifier: MIT
import packageManifest from "../package.json" with { type: "json" };

export const PACKAGE_VERSION = packageManifest.version;
