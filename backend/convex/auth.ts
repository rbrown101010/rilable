export const ACCESS_TOKEN_ENV = "RILABLE_ACCESS_TOKEN";
export const AI_PROXY_PUBLIC_ENV = "RILABLE_ALLOW_PUBLIC_AI_PROXY";

export function configuredAccessToken(): string | null {
  const token = process.env[ACCESS_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function isAccessTokenValid(accessToken: string | undefined | null): boolean {
  const expected = configuredAccessToken();
  if (!expected) return true;
  return accessToken === expected;
}

export function requireAccessToken(accessToken: string | undefined | null): void {
  if (!isAccessTokenValid(accessToken)) {
    throw new Error("Unauthorized: set AppConfig.accessToken to match RILABLE_ACCESS_TOKEN");
  }
}

export function isPublicAiProxyAllowed(): boolean {
  return process.env[AI_PROXY_PUBLIC_ENV] === "true";
}

export function httpAccessToken(request: Request): string | null {
  return request.headers.get("x-rilable-access-token");
}

export function requireAiProxyAccess(request: Request): void {
  if (isPublicAiProxyAllowed()) return;

  const expected = configuredAccessToken();
  if (!expected) {
    throw new Error(
      "AI proxy disabled: set RILABLE_ALLOW_PUBLIC_AI_PROXY=true or configure RILABLE_ACCESS_TOKEN and send x-rilable-access-token"
    );
  }

  requireAccessToken(httpAccessToken(request));
}
