const DECIMAL_ID = /^[1-9]\d{0,19}$/;

export interface GuideIdentity {
  appId: string;
  guideId: string;
}

function assertDecimalId(label: string, value: string): void {
  if (!DECIMAL_ID.test(value)) {
    throw new TypeError(`${label} must be a positive decimal string`);
  }
}

export function makeGuideKey({ appId, guideId }: GuideIdentity): string {
  assertDecimalId("appId", appId);
  assertDecimalId("guideId", guideId);
  return `${appId}:${guideId}`;
}

export function splitGuideKey(
  guideKey: string,
): Readonly<{ appId: string; guideId: string }> {
  const parts = guideKey.split(":");
  if (parts.length !== 2) {
    throw new TypeError("guideKey must have the form <appId>:<guideId>");
  }

  const [appId, guideId] = parts;
  assertDecimalId("appId", appId);
  assertDecimalId("guideId", guideId);
  return { appId, guideId };
}
