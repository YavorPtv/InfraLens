export function getAllowedOrigins(
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const configuredOrigins = environment.INFRALENS_CORS_ORIGINS;

  if (configuredOrigins !== undefined && configuredOrigins.trim().length > 0) {
    return configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

export function getCorsResponseHeaders(
  requestOrigin: string | undefined,
  allowedOrigins: string[]
): Record<string, string> {
  if (requestOrigin === undefined || !allowedOrigins.includes(requestOrigin)) {
    return {};
  }

  return {
    "access-control-allow-origin": requestOrigin,
    vary: "Origin"
  };
}
