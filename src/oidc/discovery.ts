import { OIDCDiscoveryDocument, OIDCProviderConfig } from "./types";

export const generateDiscoveryDocument = (
  config: OIDCProviderConfig
): OIDCDiscoveryDocument => {
  const baseUrl = config.baseUrl ?? config.issuer;
  const algorithm = config.keys.algorithm ?? "RS256";

  const defaultScopes = ["openid", "profile", "email", "offline_access"];
  const customScopes = config.scopes?.map((s) => s.name) ?? [];
  const allScopes = [...new Set([...defaultScopes, ...customScopes])];

  const defaultClaims = [
    "sub",
    "iss",
    "aud",
    "exp",
    "iat",
    "auth_time",
    "nonce",
    "acr",
    "amr",
    "azp",
    "at_hash",
    "email",
    "email_verified",
    "name",
    "given_name",
    "family_name",
    "picture",
    "locale",
  ];
  const customClaims = config.claims?.map((c) => c.name) ?? [];
  const allClaims = [...new Set([...defaultClaims, ...customClaims])];

  const doc: OIDCDiscoveryDocument = {
    issuer: config.issuer,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    jwks_uri: `${baseUrl}/jwks`,
    end_session_endpoint: `${baseUrl}/logout`,
    introspection_endpoint: `${baseUrl}/introspect`,
    revocation_endpoint: `${baseUrl}/revoke`,

    response_types_supported: [
      "code",
      "id_token",
      "code id_token",
    ],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
    ],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [algorithm],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: allScopes,
    claims_supported: allClaims,
    code_challenge_methods_supported: ["S256"],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };

  if (config.registration?.enabled) {
    doc.registration_endpoint = `${baseUrl}/register`;
  }

  return doc;
};
