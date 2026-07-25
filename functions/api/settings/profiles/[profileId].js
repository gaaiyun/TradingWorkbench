import {
  deleteWorkbenchProfile,
  updateWorkbenchProfile,
} from "../../_workbench_settings.mjs";
import { mutateProfileSettings } from "../../settings.js";

function profileId(context) {
  const value = context.params?.profileId;
  return Array.isArray(value) ? value[0] : value;
}

function patchInput(body) {
  if (body.patch !== undefined) return body.patch;
  if (body.profile !== undefined) return body.profile;
  const {
    revision: _revision,
    expectedUpdatedAt: _expectedUpdatedAt,
    code: _code,
    ...patch
  } = body;
  return patch;
}

export function onRequestPatch(context) {
  const id = profileId(context);
  return mutateProfileSettings(context, (settings, body) =>
    updateWorkbenchProfile(settings, id, patchInput(body)));
}

export function onRequestDelete(context) {
  const id = profileId(context);
  return mutateProfileSettings(context, (settings) =>
    deleteWorkbenchProfile(settings, id));
}
