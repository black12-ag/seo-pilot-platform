/** Better Auth provider ID for the dedicated Google Analytics grant. */
export const GA4_OAUTH_PROVIDER_ID = "google-analytics";

export const GA4_DATA_SCOPE =
  "https://www.googleapis.com/auth/analytics.readonly";

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  GA4_DATA_SCOPE,
] as const;
