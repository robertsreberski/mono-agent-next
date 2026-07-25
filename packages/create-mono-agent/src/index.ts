// SPDX-License-Identifier: MIT
export { runCreateMonoAgentCli } from "./cli.js";
export type { CreateMonoAgentCliOptions } from "./cli.js";
export { scaffoldAgent, ScaffoldError } from "./scaffold.js";
export type {
  InstallPackageManager,
  PackageInstaller,
  ScaffoldAgentOptions,
  ScaffoldResult,
} from "./scaffold.js";
export {
  COMPOSER_SKILL_TARGETS,
  installComposerSkill,
} from "./skill-installer.js";
export type {
  ComposerSkillInstallResult,
  ComposerSkillTarget,
  InstallComposerSkillOptions,
} from "./skill-installer.js";
export {
  PROJECT_TEMPLATES,
  isProjectTemplate,
  renderMinimalProject,
  renderMultiRuntimeProject,
  renderPersonalProject,
  renderProject,
} from "./templates.js";
export type {
  MinimalProjectOptions,
  ProjectIdentityOptions,
  ProjectTemplate,
  ProjectTemplateOptions,
  RenderedProjectFile,
} from "./templates.js";
