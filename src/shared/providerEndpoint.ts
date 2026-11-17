export function providerEndpointError(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.search || url.hash) {
    return "Enter an API base URL without credentials, a query, or a fragment.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Enter an HTTP or HTTPS API base URL.";
}

export function validatedProviderBaseUrl(value: string): string {
  const error = providerEndpointError(value);
  if (error) throw new Error(error);
  return value.trim().replace(/\/+$/, "");
}
