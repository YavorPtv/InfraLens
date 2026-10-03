export function getAllowedOrigins(
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const configuredOrigins = environment.INFRALENS_CORS_ORIGINS;

  if (configuredOrigins !== undefined && configuredOrigins.trim().length > 0) {
    const origins = configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.origin !== origin || origin.includes("*") || !["http:", "https:"].includes(url.protocol)) {
        throw new Error("CORS requires exact HTTP(S) origins without wildcards or paths.");
      }
    }
    return origins;
  }

  if (environment.INFRALENS_ENVIRONMENT === "production" || environment.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error("Hosted APIs require explicit INFRALENS_CORS_ORIGINS.");
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
