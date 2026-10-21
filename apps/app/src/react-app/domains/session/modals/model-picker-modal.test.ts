declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { resolveModelPickerEmptyState } from "./model-picker-modal";

describe("resolveModelPickerEmptyState", () => {
  test("shows organization recovery and hides provider connect under managed model restriction", () => {
    const state = resolveModelPickerEmptyState({
      providerGroupCount: 0,
      query: "",
      organizationModelsEmpty: true,
      restrictToCloud: true,
      organizationModelsSettingsUrl: "https://app.omnirush.example.com/dashboard/custom-llm-providers",
    });

    expect(state?.messageKey).toBe("models.organization_models_empty");
    expect(state?.showConnectProvider).toBe(false);
    expect(state?.showRefreshOrganizationModels).toBe(true);
    expect(state?.showOrganizationModelsSettings).toBe(true);
  });

  test("while providers are locked, the empty list names OmniRush sign-in and offers no provider connect", () => {
    const locked = resolveModelPickerEmptyState({ providerGroupCount: 0, query: "", organizationModelsEmpty: false, restrictToCloud: false, providerLocked: true });
    expect(locked?.messageKey).toBe("models.no_models_locked");
    expect(locked?.showConnectProvider).toBe(false);
    const open = resolveModelPickerEmptyState({ providerGroupCount: 0, query: "", organizationModelsEmpty: false, restrictToCloud: false, providerLocked: false });
    expect(open?.messageKey).toBe("models.no_models_available");
    expect(open?.showConnectProvider).toBe(true);
  });
});
