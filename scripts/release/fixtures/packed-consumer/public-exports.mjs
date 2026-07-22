export function parsePackedSmokeArgs(argv) {
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--target requires a package name.");
      }
      target = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown packed smoke argument: ${arg}`);
  }
  return { target };
}

export function publicExportSpecifiers(packageName, packageJson) {
  const exportsMap = packageJson.exports;
  if (exportsMap === undefined) {
    return typeof packageJson.main === "string" ? [packageName] : [];
  }
  if (typeof exportsMap === "string" || Array.isArray(exportsMap)) {
    return hasRuntimeTarget(exportsMap) ? [packageName] : [];
  }
  if (exportsMap === null || typeof exportsMap !== "object") {
    throw new Error(`${packageName} has an invalid packed exports field.`);
  }

  const keys = Object.keys(exportsMap);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return hasRuntimeTarget(exportsMap) ? [packageName] : [];
  }
  if (subpathKeys.length !== keys.length) {
    throw new Error(`${packageName} mixes packed export subpaths and conditions.`);
  }

  return subpathKeys
    .filter((subpath) => hasRuntimeTarget(exportsMap[subpath]))
    .sort((a, b) => a.localeCompare(b))
    .map((subpath) => {
      if (subpath.includes("*")) {
        throw new Error(`${packageName} has wildcard export ${subpath}; the packed smoke cannot derive a concrete import.`);
      }
      if (subpath === ".") return packageName;
      if (!subpath.startsWith("./") || subpath.length === 2) {
        throw new Error(`${packageName} has invalid packed export subpath ${subpath}.`);
      }
      return `${packageName}${subpath.slice(1)}`;
    });
}

function hasRuntimeTarget(target) {
  if (typeof target === "string") return true;
  if (Array.isArray(target)) return target.some(hasRuntimeTarget);
  if (target === null || typeof target !== "object") return false;
  return Object.entries(target).some(([condition, value]) =>
    condition !== "types" && hasRuntimeTarget(value));
}
