export type SettingsPrimitive = string | number | boolean | null;
export type SettingsJsonValue =
  | SettingsPrimitive
  | readonly SettingsJsonValue[]
  | { readonly [key: string]: SettingsJsonValue };

export interface SettingsJson {
  readonly [key: string]: SettingsJsonValue | undefined;
}
