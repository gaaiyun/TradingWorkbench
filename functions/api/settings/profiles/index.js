import {
  createWorkbenchProfile,
} from "../../_workbench_settings.mjs";
import { mutateProfileSettings } from "../../settings.js";

function profileInput(body) {
  if (body.profile !== undefined) return body.profile;
  const {
    revision: _revision,
    expectedUpdatedAt: _expectedUpdatedAt,
    code: _code,
    ...profile
  } = body;
  return profile;
}

export function onRequestPost(context) {
  return mutateProfileSettings(context, (settings, body) =>
    createWorkbenchProfile(settings, profileInput(body)));
}
