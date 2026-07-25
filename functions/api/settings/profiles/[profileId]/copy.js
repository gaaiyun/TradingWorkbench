import {
  copyWorkbenchProfile,
  WorkbenchSettingsError,
} from "../../../_workbench_settings.mjs";
import { mutateProfileSettings } from "../../../settings.js";

const BODY_KEYS = new Set(["revision", "expectedUpdatedAt", "options", "newId", "newName"]);
const OPTION_KEYS = new Set(["id", "name", "newId", "newName"]);

function profileId(context) {
  const value = context.params?.profileId;
  return Array.isArray(value) ? value[0] : value;
}

function copyOptions(body) {
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) {
      throw new WorkbenchSettingsError(
        "INVALID_COPY_OPTIONS",
        `profile copy 不支持字段：${key}`,
      );
    }
  }
  const nested = body.options === undefined ? {} : body.options;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new WorkbenchSettingsError(
      "INVALID_COPY_OPTIONS",
      "profile copy options 必须是对象",
    );
  }
  for (const key of Object.keys(nested)) {
    if (!OPTION_KEYS.has(key)) {
      throw new WorkbenchSettingsError(
        "INVALID_COPY_OPTIONS",
        `profile copy 不支持选项：${key}`,
      );
    }
  }

  const nestedId = nested.id !== undefined ? nested.id : nested.newId;
  const nestedName = nested.name !== undefined ? nested.name : nested.newName;
  if (
    (nested.id !== undefined && nested.newId !== undefined && nested.id !== nested.newId) ||
    (nested.name !== undefined && nested.newName !== undefined && nested.name !== nested.newName) ||
    (body.newId !== undefined && nestedId !== undefined && body.newId !== nestedId) ||
    (body.newName !== undefined && nestedName !== undefined && body.newName !== nestedName)
  ) {
    throw new WorkbenchSettingsError(
      "COPY_OPTIONS_CONFLICT",
      "profile copy 选项互相冲突",
    );
  }

  const id = body.newId !== undefined ? body.newId : nestedId;
  const name = body.newName !== undefined ? body.newName : nestedName;
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  };
}

export function onRequestPost(context) {
  const id = profileId(context);
  return mutateProfileSettings(context, (settings, body) =>
    copyWorkbenchProfile(settings, id, copyOptions(body)));
}
