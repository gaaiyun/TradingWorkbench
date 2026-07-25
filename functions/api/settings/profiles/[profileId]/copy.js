import { copyWorkbenchProfile } from "../../../_workbench_settings.mjs";
import { mutateProfileSettings } from "../../../settings.js";

function profileId(context) {
  const value = context.params?.profileId;
  return Array.isArray(value) ? value[0] : value;
}

function copyOptions(body) {
  if (body.options !== undefined) return body.options;
  if (body.profile !== undefined) return body.profile;
  const {
    revision: _revision,
    expectedUpdatedAt: _expectedUpdatedAt,
    code: _code,
    ...options
  } = body;
  return options;
}

export function onRequestPost(context) {
  const id = profileId(context);
  return mutateProfileSettings(context, (settings, body) =>
    copyWorkbenchProfile(settings, id, copyOptions(body)));
}
